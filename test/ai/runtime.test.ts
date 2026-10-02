/**
 * External runtime adapter contract tests.
 *
 * The gateway must route provider-backed work to the configured runtime before
 * provider resolution or AI SDK construction. The command adapter is tested
 * with a real child process using stdin/stdout JSON, not a mocked spawn.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __setGenerateTextTransportForTests,
  __setRuntimeAdapterForTests,
  chat,
  configureGateway,
  embed,
  embedMultimodal,
  expand,
  isAvailable,
  probeChatModel,
  resetGateway,
  rerank,
  type ChatResult,
} from '../../src/core/ai/gateway.ts';
import {
  CommandRuntimeAdapter,
  makeRuntimeRequest,
  RUNTIME_PROTOCOL,
  type RuntimeAdapter,
  type RuntimeCapability,
  type RuntimeRequest,
  type RuntimeResponse,
} from '../../src/core/ai/runtime.ts';
import { loadConfig } from '../../src/core/config.ts';
import { buildGatewayConfig } from '../../src/core/ai/build-gateway-config.ts';
import { makeJudgeClient } from '../../src/core/cycle/synthesize.ts';
import { withEnv } from '../helpers/with-env.ts';

class FakeRuntime implements RuntimeAdapter {
  readonly capabilities = new Set<RuntimeAdapter['capabilities'] extends ReadonlySet<infer T> ? T : never>([
    'chat',
    'structured',
    'embedding',
    'reranker',
  ]);
  readonly requests: RuntimeRequest[] = [];

  async invoke(request: RuntimeRequest): Promise<RuntimeResponse> {
    this.requests.push(request);
    if (request.operation === 'chat') {
      const result: ChatResult = {
        text: 'runtime answer',
        blocks: [{ type: 'text', text: 'runtime answer' }],
        stopReason: 'end',
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
        model: 'external:default',
        providerId: 'runtime',
      };
      return completed(request, result);
    }
    if (request.operation === 'structured') {
      return completed(request, { queries: ['related query', 'another angle'] });
    }
    if (request.operation === 'embedding') {
      return completed(request, { embeddings: [[1, 0], [0, 1]] });
    }
    if (request.operation === 'reranker') {
      return completed(request, { results: [{ index: 1, relevanceScore: 0.9 }, { index: 0, relevanceScore: 0.2 }] });
    }
    return {
      protocol: RUNTIME_PROTOCOL,
      request_id: request.request_id,
      operation: request.operation,
      status: 'unsupported',
    };
  }
}

class ResultRuntime implements RuntimeAdapter {
  readonly capabilities: ReadonlySet<RuntimeCapability>;
  readonly requests: RuntimeRequest[] = [];

  constructor(capabilities: RuntimeCapability[], private readonly value: unknown) {
    this.capabilities = new Set(capabilities);
  }

  async invoke(request: RuntimeRequest): Promise<RuntimeResponse> {
    this.requests.push(request);
    return completed(request, this.value);
  }
}

function completed(request: RuntimeRequest, result: unknown): RuntimeResponse {
  return {
    protocol: RUNTIME_PROTOCOL,
    request_id: request.request_id,
    operation: request.operation,
    status: 'completed',
    result,
  };
}

afterEach(() => {
  resetGateway();
  __setGenerateTextTransportForTests(null);
});

describe('runtime mode gateway routing', () => {
  test('chat uses runtime without provider key or AI SDK transport', async () => {
    const runtime = new FakeRuntime();
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      env: {},
    });
    __setRuntimeAdapterForTests(runtime);
    __setGenerateTextTransportForTests(async () => {
      throw new Error('AI SDK transport must not be called in runtime mode');
    });

    expect(isAvailable('chat')).toBe(true);
    expect(probeChatModel('anthropic:claude-sonnet-4-6')).toEqual({ ok: true });
    const result = await chat({ messages: [{ role: 'user', content: 'hello' }] });

    expect(result.text).toBe('runtime answer');
    expect(result.providerId).toBe('runtime');
    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0]!.operation).toBe('chat');
    expect(runtime.requests[0]!.protocol).toBe(RUNTIME_PROTOCOL);
  });

  test('dream significance judge uses runtime without Anthropic key or recipe model', async () => {
    const runtime = new FakeRuntime();
    configureGateway({
      chat_model: 'external:opaque',
      env: {},
    });
    __setRuntimeAdapterForTests(runtime);

    const judge = makeJudgeClient('external:opaque');
    expect(judge).not.toBeNull();
    const result = await judge!.create({
      model: 'external:opaque',
      max_tokens: 100,
      system: 'judge',
      messages: [{ role: 'user', content: 'assess this' }],
    } as any);

    expect(result.content?.[0]).toEqual({ type: 'text', text: 'runtime answer' });
    expect(runtime.requests[0]!.operation).toBe('chat');
  });

  test('structured expansion uses runtime and preserves original query', async () => {
    const runtime = new FakeRuntime();
    configureGateway({
      expansion_model: 'anthropic:claude-haiku-4-5-20251001',
      env: {},
    });
    __setRuntimeAdapterForTests(runtime);

    expect(isAvailable('expansion')).toBe(true);
    await expect(expand('gbrain runtime')).resolves.toEqual([
      'gbrain runtime',
      'related query',
      'another angle',
    ]);
    expect(runtime.requests.map(request => request.operation)).toEqual(['structured']);
  });

  test('embedding and reranker bypass provider resolution in runtime mode', async () => {
    const runtime = new FakeRuntime();
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: 2,
      reranker_model: 'zeroentropyai:zerank-2',
      env: {},
    });
    __setRuntimeAdapterForTests(runtime);

    await expect(embed(['a', 'b'])).resolves.toEqual([
      new Float32Array([1, 0]),
      new Float32Array([0, 1]),
    ]);
    await expect(rerank({ query: 'q', documents: ['a', 'b'] })).resolves.toEqual([
      { index: 1, relevanceScore: 0.9 },
      { index: 0, relevanceScore: 0.2 },
    ]);
    expect(runtime.requests.map(request => request.operation)).toEqual(['embedding', 'reranker']);
  });

  test('runtime capability absence fails closed without native fallback', async () => {
    configureGateway({
      embedding_model: 'external:embedding',
      reranker_model: 'external:reranker',
      env: {},
      runtime: { command: process.execPath, capabilities: ['chat'] },
    });

    expect(isAvailable('embedding')).toBe(false);
    expect(isAvailable('reranker')).toBe(false);
    await expect(embed(['a'])).rejects.toMatchObject({ code: 'capability_unavailable' });
    await expect(rerank({ query: 'q', documents: ['a'] })).rejects.toMatchObject({ code: 'capability_unavailable' });
  });

  test('runtime embedding validates count, finite values, and multimodal count', async () => {
    const partial = new ResultRuntime(['embedding'], { embeddings: [[1, 0]] });
    configureGateway({ embedding_model: 'external:embedding', embedding_dimensions: 2, env: {} });
    __setRuntimeAdapterForTests(partial);
    await expect(embed(['a', 'b'])).rejects.toMatchObject({ code: 'invalid_response' });

    const nonFinite = new ResultRuntime(['embedding'], { embeddings: [[1, Number.NaN]] });
    configureGateway({ embedding_model: 'external:embedding', embedding_dimensions: 2, env: {} });
    __setRuntimeAdapterForTests(nonFinite);
    await expect(embed(['a'])).rejects.toMatchObject({ code: 'invalid_response' });

    const invalidRerank = new ResultRuntime(['reranker'], { results: [{ index: 1, relevanceScore: 0.9 }] });
    configureGateway({ reranker_model: 'external:reranker', env: {} });
    __setRuntimeAdapterForTests(invalidRerank);
    await expect(rerank({ query: 'q', documents: ['a'] })).rejects.toMatchObject({ code: 'invalid_response' });

    const partialMultimodal = new ResultRuntime(['embedding_multimodal'], { embeddings: [] });
    configureGateway({ embedding_model: 'external:embedding', env: {} });
    __setRuntimeAdapterForTests(partialMultimodal);
    await expect(embedMultimodal([{ kind: 'text', text: 'a' }])).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('runtime config plumbing', () => {
  test('loads command, args, capabilities, and limits from the environment', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-runtime-config-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(
      join(home, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'pglite', database_path: join(home, 'db') }),
    );
    try {
      await withEnv({
        GBRAIN_HOME: home,
        GBRAIN_DATABASE_URL: undefined,
        DATABASE_URL: undefined,
        GBRAIN_RUNTIME_COMMAND: '/usr/local/bin/external-runtime',
        GBRAIN_RUNTIME_ARGS_JSON: JSON.stringify(['--stdio']),
        GBRAIN_RUNTIME_CAPABILITIES: 'chat,structured,embedding',
        GBRAIN_RUNTIME_TIMEOUT_MS: '1234',
        GBRAIN_RUNTIME_MAX_OUTPUT_BYTES: '5678',
      }, async () => {
        const config = loadConfig();
        expect(config?.runtime).toEqual({
          command: '/usr/local/bin/external-runtime',
          args: ['--stdio'],
          capabilities: ['chat', 'structured', 'embedding'],
          timeout_ms: 1234,
          max_output_bytes: 5678,
        });
        expect(buildGatewayConfig(config!).runtime).toEqual(config!.runtime);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('CommandRuntimeAdapter', () => {
  test('sends a versioned request over stdin and validates the response', async () => {
    const script = [
      "let body = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => body += chunk);",
      "process.stdin.on('end', () => {",
      "  const request = JSON.parse(body);",
      "  process.stdout.write(JSON.stringify({ protocol: request.protocol, request_id: request.request_id, operation: request.operation, status: 'completed', result: { ok: true } }));",
      "});",
    ].join('');
    const adapter = new CommandRuntimeAdapter({
      command: process.execPath,
      args: ['-e', script],
      capabilities: ['chat'],
      timeout_ms: 5_000,
    });
    const request = makeRuntimeRequest('chat', { messages: [] }, 'model:test', 'request-1');

    await expect(adapter.invoke(request)).resolves.toMatchObject({
      protocol: RUNTIME_PROTOCOL,
      request_id: 'request-1',
      operation: 'chat',
      status: 'completed',
      result: { ok: true },
    });
  });

  test('returns unsupported without spawning when capability is absent', async () => {
    const adapter = new CommandRuntimeAdapter({ command: process.execPath, capabilities: ['chat'] });
    const request = makeRuntimeRequest('reranker', {}, undefined, 'request-unsupported');

    await expect(adapter.invoke(request)).resolves.toMatchObject({
      status: 'unsupported',
      request_id: 'request-unsupported',
      operation: 'reranker',
    });
  });

  test('times out and terminates a stuck runtime', async () => {
    const adapter = new CommandRuntimeAdapter({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10_000)'],
      capabilities: ['chat'],
      timeout_ms: 25,
    });
    const request = makeRuntimeRequest('chat', {}, undefined, 'request-timeout');

    await expect(adapter.invoke(request)).rejects.toMatchObject({ code: 'timeout' });
  });

  test('does not pass provider credentials to the runtime child process', async () => {
    const script = [
      "let body = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => body += chunk);",
      "process.stdin.on('end', () => {",
      "  const request = JSON.parse(body);",
      "  process.stdout.write(JSON.stringify({ protocol: request.protocol, request_id: request.request_id, operation: request.operation, status: 'completed', result: { anthropic: process.env.ANTHROPIC_API_KEY ?? null, openai: process.env.OPENAI_API_KEY ?? null, marker: process.env.GBRAIN_RUNTIME_TEST_MARKER ?? null } }));",
      "});",
    ].join('');

    await withEnv({
      ANTHROPIC_API_KEY: 'gbrain-must-not-forward',
      OPENAI_API_KEY: 'gbrain-must-not-forward',
      ZEROENTROPY_API_KEY: 'gbrain-must-not-forward',
      GBRAIN_RUNTIME_TEST_MARKER: 'forwarded',
    }, async () => {
      const adapter = new CommandRuntimeAdapter({
        command: process.execPath,
        args: ['-e', script],
        capabilities: ['chat'],
        timeout_ms: 5_000,
      });
      const result = await adapter.invoke(makeRuntimeRequest('chat', {}, undefined, 'request-env-isolated'));
      expect(result).toMatchObject({
        status: 'completed',
        result: { anthropic: null, openai: null, marker: 'forwarded' },
      });
    });
  });

  test('rejects malformed runtime output', async () => {
    const adapter = new CommandRuntimeAdapter({
      command: process.execPath,
      args: ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('{}'))"],
      capabilities: ['chat'],
      timeout_ms: 5_000,
    });
    const request = makeRuntimeRequest('chat', {}, undefined, 'request-invalid');

    await expect(adapter.invoke(request)).rejects.toMatchObject({ code: 'protocol_mismatch' });
  });
});
