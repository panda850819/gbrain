/**
 * Reference Hermes bridge tests.
 *
 * The bridge is exercised with a fake Hermes executable so this suite proves
 * protocol/file handling without making a real inference request.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandRuntimeAdapter, makeRuntimeRequest, RUNTIME_PROTOCOL } from '../src/core/ai/runtime.ts';
import { withEnv } from './helpers/with-env.ts';

const bridgePath = fileURLToPath(new URL('../scripts/runtime/hermes-runtime.py', import.meta.url));

function fakeHermesScript(): string {
  return [
    "import fs from 'node:fs';",
    "const index = process.argv.indexOf('--query-file');",
    "const query = index >= 0 ? fs.readFileSync(process.argv[index + 1], 'utf8') : '';",
    "const structured = process.env.GBRAIN_RUNTIME_FAKE_HERMES_OPERATION === 'structured';",
    "process.stdout.write(JSON.stringify(structured ? { queries: ['fake expansion'] } : { text: 'fake Hermes result', blocks: [{ type: 'text', text: 'fake Hermes result' }], stopReason: 'end' }));",
  ].join('');
}

async function withFakeHermes(operation: 'chat' | 'structured', fn: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-hermes-bridge-test-'));
  const fakePath = join(dir, 'fake-hermes.mjs');
  writeFileSync(fakePath, `#!/usr/bin/env bun\n${fakeHermesScript()}\n`);
  chmodSync(fakePath, 0o755);
  try {
    await withEnv({
      GBRAIN_RUNTIME_HERMES_BIN: fakePath,
      GBRAIN_RUNTIME_FAKE_HERMES_OPERATION: operation,
      ANTHROPIC_API_KEY: undefined,
    }, fn);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fakeCapabilityScript(): string {
  return [
    "let body = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => body += chunk);",
    "process.stdin.on('end', () => {",
    "  const request = JSON.parse(body);",
    "  const result = request.operation === 'reranker'"
      + " ? { results: [{ index: 1, relevanceScore: 0.9 }, { index: 0, relevanceScore: 0.2 }] }"
      + " : { embeddings: request.operation === 'embedding_multimodal' ? [[0.5, 0.5]] : [[1, 0], [0, 1]] };",
    "  process.stdout.write(JSON.stringify(result));",
    "});",
  ].join('');
}

async function withFakeCapabilityHelpers(fn: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-runtime-helper-test-'));
  const helperPath = join(dir, 'fake-capability-helper.mjs');
  writeFileSync(helperPath, `#!/usr/bin/env bun\n${fakeCapabilityScript()}\n`);
  chmodSync(helperPath, 0o755);
  try {
    await withEnv({
      GBRAIN_RUNTIME_HERMES_EMBEDDING_COMMAND: helperPath,
      GBRAIN_RUNTIME_HERMES_EMBEDDING_MULTIMODAL_COMMAND: helperPath,
      GBRAIN_RUNTIME_HERMES_RERANKER_COMMAND: helperPath,
      GBRAIN_RUNTIME_HERMES_EMBEDDING_COMMAND_ARGS_JSON: undefined,
      GBRAIN_RUNTIME_HERMES_EMBEDDING_MULTIMODAL_COMMAND_ARGS_JSON: undefined,
      GBRAIN_RUNTIME_HERMES_RERANKER_COMMAND_ARGS_JSON: undefined,
      ANTHROPIC_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
    }, fn);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

afterEach(() => {
  // withEnv restores process.env for each test; this hook exists as a visual
  // reminder that the bridge must never leak runtime configuration.
});

describe('Hermes stdio bridge', () => {
  test('routes chat through Hermes query-file without provider API keys', async () => {
    await withFakeHermes('chat', async () => {
      const adapter = new CommandRuntimeAdapter({
        command: 'python3',
        args: [bridgePath],
        capabilities: ['chat'],
        timeout_ms: 10_000,
      });
      const request = makeRuntimeRequest('chat', { messages: [{ role: 'user', content: 'hello' }] }, 'external:hermes', 'bridge-chat');
      const result = await adapter.invoke(request);

      expect(result).toMatchObject({
        protocol: RUNTIME_PROTOCOL,
        request_id: 'bridge-chat',
        operation: 'chat',
        status: 'completed',
        result: { text: 'fake Hermes result' },
      });
    });
  });

  test('routes structured output through the same bridge', async () => {
    await withFakeHermes('structured', async () => {
      const adapter = new CommandRuntimeAdapter({
        command: 'python3',
        args: [bridgePath],
        capabilities: ['structured'],
        timeout_ms: 10_000,
      });
      const request = makeRuntimeRequest('structured', { schema: { type: 'object' } }, 'external:hermes', 'bridge-structured');
      const result = await adapter.invoke(request);

      expect(result).toMatchObject({
        status: 'completed',
        request_id: 'bridge-structured',
        result: { queries: ['fake expansion'] },
      });
    });
  });
});

describe('Hermes optional capability helpers', () => {
  test('routes embedding, multimodal embedding, and reranker through helpers', async () => {
    await withFakeCapabilityHelpers(async () => {
      const adapter = new CommandRuntimeAdapter({
        command: 'python3',
        args: [bridgePath],
        capabilities: ['embedding', 'embedding_multimodal', 'reranker'],
        timeout_ms: 10_000,
      });

      const embedding = await adapter.invoke(
        makeRuntimeRequest('embedding', { texts: ['a', 'b'] }, 'openai:text-embedding-3-small', 'bridge-embedding'),
      );
      expect(embedding).toMatchObject({
        status: 'completed',
        request_id: 'bridge-embedding',
        result: { embeddings: [[1, 0], [0, 1]] },
      });

      const multimodal = await adapter.invoke(
        makeRuntimeRequest(
          'embedding_multimodal',
          { inputs: [{ kind: 'text', text: 'image query' }], inputType: 'query' },
          'voyage:voyage-multimodal-3',
          'bridge-embedding-multimodal',
        ),
      );
      expect(multimodal).toMatchObject({
        status: 'completed',
        request_id: 'bridge-embedding-multimodal',
        result: { embeddings: [[0.5, 0.5]] },
      });

      const reranker = await adapter.invoke(
        makeRuntimeRequest(
          'reranker',
          { query: 'q', documents: ['a', 'b'], topN: 2 },
          'zeroentropyai:zerank-2',
          'bridge-reranker',
        ),
      );
      expect(reranker).toMatchObject({
        status: 'completed',
        request_id: 'bridge-reranker',
        result: { results: [{ index: 1, relevanceScore: 0.9 }, { index: 0, relevanceScore: 0.2 }] },
      });
    });
  });

  test('reports optional embedding as unsupported when no helper is configured', async () => {
    await withEnv({
      GBRAIN_RUNTIME_HERMES_EMBEDDING_COMMAND: undefined,
      GBRAIN_RUNTIME_HERMES_EMBEDDING_MULTIMODAL_COMMAND: undefined,
      GBRAIN_RUNTIME_HERMES_RERANKER_COMMAND: undefined,
    }, async () => {
      const adapter = new CommandRuntimeAdapter({
        command: 'python3',
        args: [bridgePath],
        capabilities: ['embedding'],
        timeout_ms: 10_000,
      });
      const result = await adapter.invoke(
        makeRuntimeRequest('embedding', { texts: ['a'] }, 'openai:text-embedding-3-small', 'bridge-embedding-unsupported'),
      );
      expect(result).toMatchObject({
        status: 'unsupported',
        request_id: 'bridge-embedding-unsupported',
        operation: 'embedding',
      });
    });
  });
});
