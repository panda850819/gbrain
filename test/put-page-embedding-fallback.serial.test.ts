/**
 * #40 — remote MCP put_page must persist page content when the embedding
 * provider rejects the request. The write is durable first; embedding is a
 * recoverable, observable degradation.
 *
 * This is a real HTTP MCP boundary over PGLite, not a direct handler call:
 * bearer auth, JSON-RPC tools/call dispatch, put_page, and exact get_page all
 * run through the same transport seam used by the remote deployment.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { embedStalePages } from '../src/core/embed-stale.ts';
import { classifyEmbeddingFailure } from '../src/core/embedding-failure.ts';
import { startHttpTransport } from '../src/mcp/http-transport.ts';
import {
  __setEmbedTransportForTests,
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import type { AIGatewayConfig } from '../src/core/ai/types.ts';

setDefaultTimeout(60_000);

interface HttpServer {
  port: number;
  stop: () => Promise<void>;
}

function rpc(method: string, params: unknown, id = 1): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> })?.content;
  return Array.isArray(content) ? content.map((part) => part.text ?? '').join('\n') : '';
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const gatewayConfig: AIGatewayConfig = {
  embedding_model: 'openai:text-embedding-3-large',
  embedding_dimensions: 1536,
  chat_model: 'anthropic:claude-sonnet-4-6',
  expansion_model: 'anthropic:claude-haiku-4-5',
  env: { OPENAI_API_KEY: '<test-placeholder>' },
  base_urls: {},
};

describe('#40 — remote MCP put_page survives embedding-provider failure', () => {
  let engine: PGLiteEngine;
  let server: HttpServer;
  let token: string;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    token = `gbrain_test_${randomBytes(16).toString('hex')}`;
    await engine.executeRaw(
      `INSERT INTO access_tokens (name, token_hash)
       VALUES ('put-page-embedding-fallback', '${hashToken(token)}')`,
    );

    configureGateway(gatewayConfig);
    __setEmbedTransportForTests(async () => {
      throw new Error('[embed(openai:text-embedding-3-large)] You have no credits remaining.');
    });

    const started = await startHttpTransport({ port: 0, engine });
    server = {
      port: (started as { port: number }).port,
      stop: async () => { (started as { stop: (close?: boolean) => void }).stop(true); },
    };
  });

  afterAll(async () => {
    if (server) await server.stop();
    await engine.disconnect();
    resetGateway();
  });

  async function callTool(name: string, args: Record<string, unknown>): Promise<Response> {
    return fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: rpc('tools/call', { name, arguments: args }),
    });
  }

  test('put_page succeeds, reports degraded embedding, and exact get_page reads it back', async () => {
    const slug = `sessions/debug/put-page-embedding-fallback-${randomBytes(6).toString('hex')}`;
    const content = [
      '---',
      'type: note',
      'title: Embedding fallback probe',
      '---',
      '',
      'This page must survive an embedding quota failure.',
    ].join('\n');

    const putResponse = await callTool('put_page', { slug, content });
    expect(putResponse.status).toBe(200);
    const putRpc = await putResponse.json() as { result?: { isError?: boolean; content?: unknown } };
    expect(putRpc.result?.isError).not.toBe(true);
    const put = JSON.parse(textOf(putRpc.result)) as {
      slug: string;
      status: string;
      chunks: number;
      embedding?: {
        status: string;
        error_code: string;
        reason: string;
        message: string;
        suggestion: string;
        attempted_chunks: number;
      };
    };
    expect(put.slug).toBe(slug);
    expect(put.status).toBe('created_or_updated');
    expect(put.chunks).toBeGreaterThan(0);
    expect(put.embedding?.status).toBe('degraded');
    expect(put.embedding?.error_code).toBe('embedding_failed');
    expect(put.embedding?.reason).toBe('quota_exhausted');
    expect(put.embedding?.attempted_chunks).toBe(put.chunks);
    expect(put.embedding?.message).toContain('persisted without embeddings');
    expect(put.embedding?.suggestion).toContain('gbrain embed --stale');
    expect(put.embedding?.message).not.toContain('sk-test');
    expect(put.embedding?.message).not.toContain('credits remaining');

    const getResponse = await callTool('get_page', {
      slug,
      fuzzy: false,
      include_content: true,
    });
    expect(getResponse.status).toBe(200);
    const getRpc = await getResponse.json() as { result?: { isError?: boolean; content?: unknown } };
    expect(getRpc.result?.isError).not.toBe(true);
    const page = JSON.parse(textOf(getRpc.result)) as {
      slug: string;
      content?: string;
      compiled_truth?: string;
    };
    expect(page.slug).toBe(slug);
    expect(page.content).toContain('This page must survive an embedding quota failure.');
    expect(page.compiled_truth).toContain('This page must survive an embedding quota failure.');

    const chunks = await engine.getChunks(slug, { sourceId: 'default', includeEmbedding: true });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.embedding == null)).toBe(true);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBeGreaterThanOrEqual(chunks.length);
    const [stored] = await engine.executeRaw<{ embedding_signature: string | null }>(
      'SELECT embedding_signature FROM pages WHERE source_id = $1 AND slug = $2',
      ['default', slug],
    );
    expect(stored?.embedding_signature ?? null).toBeNull();

    const backfill = await embedStalePages(engine, [slug], 'default', {
      embedFn: async (texts) => texts.map(() => new Float32Array(1536).fill(0.25)),
    });
    expect(backfill.embedded).toBe(chunks.length);
    expect(backfill.pagesProcessed).toBe(1);
    const recoveredChunks = await engine.getChunks(slug, {
      sourceId: 'default',
      includeEmbedding: true,
    });
    expect(recoveredChunks.every((chunk) => chunk.embedding != null)).toBe(true);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(0);
  });

  test('classifies provider failures into the bounded, sanitized contract', () => {
    const cases = [
      ['quota exhausted trace=provider-private-marker', 'quota_exhausted'],
      ['429 Too Many Requests trace=provider-private-marker', 'rate_limited'],
      ['401 Unauthorized: api key rejected trace=provider-private-marker', 'authentication_failed'],
      ['socket hang up trace=provider-private-marker', 'provider_unavailable'],
    ] as const;

    for (const [providerError, reason] of cases) {
      expect(classifyEmbeddingFailure(new Error(providerError))).toBe(reason);
    }
  });
});
