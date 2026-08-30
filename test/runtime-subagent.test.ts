/**
 * Runtime-mode subagent regression.
 *
 * A runtime-backed job may carry an opaque model intent. Queue and handler
 * capability gates must not reject it or construct the legacy Anthropic SDK.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { makeSubagentHandler } from '../src/core/minions/handlers/subagent.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import {
  __setRuntimeAdapterForTests,
  configureGateway,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { RUNTIME_PROTOCOL, type RuntimeAdapter, type RuntimeRequest, type RuntimeResponse } from '../src/core/ai/runtime.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

class FakeRuntime implements RuntimeAdapter {
  readonly capabilities = new Set<RuntimeAdapter['capabilities'] extends ReadonlySet<infer T> ? T : never>(['chat']);
  readonly requests: RuntimeRequest[] = [];

  async invoke(request: RuntimeRequest): Promise<RuntimeResponse> {
    this.requests.push(request);
    const result: ChatResult = {
      text: 'runtime subagent result',
      blocks: [{ type: 'text', text: 'runtime subagent result' }],
      stopReason: 'end',
      usage: { input_tokens: 4, output_tokens: 3, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'external:runtime',
      providerId: 'runtime',
    };
    return {
      protocol: RUNTIME_PROTOCOL,
      request_id: request.request_id,
      operation: request.operation,
      status: 'completed',
      result,
    };
  }
}

class WholeSubagentRuntime implements RuntimeAdapter {
  readonly capabilities = new Set<RuntimeAdapter['capabilities'] extends ReadonlySet<infer T> ? T : never>(['subagent']);
  readonly requests: RuntimeRequest[] = [];

  constructor(private readonly writes = ['reflections/dreams/runtime-result']) {}

  async invoke(request: RuntimeRequest): Promise<RuntimeResponse> {
    this.requests.push(request);
    return {
      protocol: RUNTIME_PROTOCOL,
      request_id: request.request_id,
      operation: request.operation,
      status: 'completed',
      result: {
        result: 'whole runtime result',
        turns_count: 2,
        stop_reason: 'end_turn',
        tokens: { in: 11, out: 7, cache_read: 0, cache_create: 0 },
        artifacts: this.writes,
        writes: this.writes,
      },
    };
  }
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
});

afterAll(async () => {
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM subagent_tool_executions');
  await engine.executeRaw('DELETE FROM subagent_messages');
  await engine.executeRaw('DELETE FROM subagent_rate_leases');
  await engine.executeRaw('DELETE FROM minion_jobs');
});

function makeContext(job: { id: number; name: string; data: Record<string, unknown> }): MinionJobContext {
  const signal = new AbortController();
  const shutdownSignal = new AbortController();
  return {
    id: job.id,
    name: job.name,
    data: job.data,
    attempts_made: 0,
    signal: signal.signal,
    deadlineAtMs: null,
    shutdownSignal: shutdownSignal.signal,
    async updateProgress() {},
    async updateTokens() {},
    async log() {},
    async isActive() { return true; },
    async readInbox() { return []; },
  };
}

describe('runtime-mode subagent execution', () => {
  test('opaque model bypasses provider gates and never constructs Anthropic', async () => {
    const runtime = new FakeRuntime();
    configureGateway({
      chat_model: 'external:opaque',
      env: {},
      runtime: { command: process.execPath, capabilities: ['chat'] },
    });
    __setRuntimeAdapterForTests(runtime);

    let makeAnthropicCalled = false;
    const handler = makeSubagentHandler({
      engine,
      toolRegistry: [],
      makeAnthropic: () => {
        makeAnthropicCalled = true;
        throw new Error('Anthropic must not be constructed in runtime mode');
      },
    });
    const job = await queue.add(
      'subagent',
      { prompt: 'run through runtime', model: 'external:opaque' },
      {},
      { allowProtectedSubmit: true },
    );

    const result = await handler(makeContext({ id: job.id, name: job.name, data: job.data as Record<string, unknown> }));

    expect(result.result).toBe('runtime subagent result');
    expect(result.stop_reason).toBe('end_turn');
    expect(makeAnthropicCalled).toBe(false);
    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0]!.operation).toBe('chat');
    expect(runtime.requests[0]!.model).toBe('external:opaque');
  });

  test('whole subagent capability delegates tool loop to runtime', async () => {
    const runtime = new WholeSubagentRuntime();
    configureGateway({
      chat_model: 'external:opaque',
      env: {},
      runtime: { command: process.execPath, capabilities: ['subagent'] },
    });
    __setRuntimeAdapterForTests(runtime);

    let makeAnthropicCalled = false;
    const handler = makeSubagentHandler({
      engine,
      toolRegistry: [],
      makeAnthropic: () => {
        makeAnthropicCalled = true;
        throw new Error('Anthropic must not be constructed in external subagent mode');
      },
    });
    await engine.putPage('reflections/dreams/runtime-result', {
      type: 'note',
      title: 'Runtime result',
      compiled_truth: 'The external runtime wrote this page.',
      timeline: '',
      frontmatter: { type: 'note', title: 'Runtime result' },
    });
    const job = await queue.add(
      'subagent',
      {
        prompt: 'run whole job through runtime',
        model: 'external:opaque',
        allowed_slug_prefixes: ['reflections/dreams/*'],
      },
      {},
      { allowProtectedSubmit: true },
    );

    const result = await handler(makeContext({ id: job.id, name: job.name, data: job.data as Record<string, unknown> }));

    expect(result.result).toBe('whole runtime result');
    expect(result.turns_count).toBe(2);
    expect(result.runtime?.request_id).toBe(runtime.requests[0]!.request_id);
    expect(result.runtime?.writes).toEqual(['reflections/dreams/runtime-result']);
    expect(makeAnthropicCalled).toBe(false);
    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0]!.operation).toBe('subagent');
  });

  test('fails closed when runtime write receipt cannot be read back', async () => {
    const runtime = new WholeSubagentRuntime(['reflections/dreams/missing-runtime-result']);
    configureGateway({
      chat_model: 'external:opaque',
      env: {},
      runtime: { command: process.execPath, capabilities: ['subagent'] },
    });
    __setRuntimeAdapterForTests(runtime);

    const handler = makeSubagentHandler({
      engine,
      toolRegistry: [],
      makeAnthropic: () => {
        throw new Error('Anthropic must not be constructed in external subagent mode');
      },
    });
    const job = await queue.add(
      'subagent',
      {
        prompt: 'reject an unverifiable runtime write',
        model: 'external:opaque',
        allowed_slug_prefixes: ['reflections/dreams/*'],
      },
      {},
      { allowProtectedSubmit: true },
    );

    await expect(
      handler(makeContext({ id: job.id, name: job.name, data: job.data as Record<string, unknown> })),
    ).rejects.toThrow('not readable after completion');
  });
});
