import { describe, expect, test } from 'bun:test';
import { OperationError, operations } from '../src/core/operations.ts';
import type { AuthInfo, Operation, OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const putPage = operations.find((operation) => operation.name === 'put_page') as Operation;
if (!putPage) throw new Error('put_page op missing');

type EngineCall = { method: string; args: unknown[] };

function recordingEngine(): { engine: BrainEngine; calls: EngineCall[] } {
  const calls: EngineCall[] = [];
  const engine = {
    executeRaw: async (...args: unknown[]) => {
      calls.push({ method: 'executeRaw', args });
      return [{ local_path: null }];
    },
  } as unknown as BrainEngine;
  return { engine, calls };
}

function federatedAuth(sourceId: string): AuthInfo {
  return {
    token: 'test-token',
    clientId: 'gbrain-cl-source-assertion',
    scopes: ['read', 'write'],
    sourceId,
    allowedSources: ['other', 'default'],
  };
}

function makeCtx(
  sourceId: string,
  engine: BrainEngine,
  overrides: Partial<OperationContext> = {},
): OperationContext {
  return {
    engine,
    config: { engine: 'postgres' } as OperationContext['config'],
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: true,
    remote: true,
    sourceId,
    auth: federatedAuth(sourceId),
    ...overrides,
  };
}

const baseParams = { slug: 'topics/source-assertion', content: 'stub' };

async function expectOperationError(
  promise: Promise<unknown>,
  code: string,
): Promise<OperationError> {
  try {
    await promise;
    throw new Error('expected operation to reject');
  } catch (error) {
    expect(error).toBeInstanceOf(OperationError);
    expect((error as OperationError).code).toBe(code);
    return error as OperationError;
  }
}

describe('put_page expected_source_id assertion', () => {
  test('is exposed as an optional string in the operation schema', () => {
    expect(putPage.params.expected_source_id).toMatchObject({
      type: 'string',
      required: false,
    });
  });

  test("federated reads do not let scalar source 'other' satisfy expected 'default'", async () => {
    const { engine, calls } = recordingEngine();
    const error = await expectOperationError(
      putPage.handler(makeCtx('other', engine), {
        ...baseParams,
        slug: 'INVALID SLUG',
        expected_source_id: 'default',
        source_kind: 'capture-cli',
      }),
      'source_mismatch',
    );

    expect(error.message).toContain("expected source 'default'");
    expect(error.message).toContain("effective write source 'other'");
    expect(calls).toEqual([]);
  });

  test("matching scalar source 'default' reaches the existing dry-run path", async () => {
    const { engine, calls } = recordingEngine();
    const result = await putPage.handler(makeCtx('default', engine), {
      ...baseParams,
      expected_source_id: 'default',
    });

    expect(result).toEqual({ dry_run: true, action: 'put_page', slug: baseParams.slug });
    expect(calls.map((call) => call.method)).toEqual(['executeRaw']);
    expect(calls[0]?.args[1]).toEqual(['default']);
  });

  test("matching scalar source 'other' can pass", async () => {
    const { engine, calls } = recordingEngine();
    const result = await putPage.handler(makeCtx('other', engine), {
      ...baseParams,
      expected_source_id: 'other',
    });

    expect(result).toMatchObject({ dry_run: true, action: 'put_page' });
    expect(calls.map((call) => call.method)).toEqual(['executeRaw']);
    expect(calls[0]?.args[1]).toEqual(['other']);
  });

  test("a missing context source uses the legacy 'default' write floor", async () => {
    const { engine, calls } = recordingEngine();
    const ctx = makeCtx('default', engine, { remote: false });
    (ctx as { sourceId?: string }).sourceId = undefined;
    const result = await putPage.handler(ctx, {
      ...baseParams,
      expected_source_id: 'default',
    });

    expect(result).toMatchObject({ dry_run: true, action: 'put_page' });
    expect(calls).toEqual([]);
  });

  test('omitting expected_source_id preserves the existing behavior', async () => {
    const { engine, calls } = recordingEngine();
    const result = await putPage.handler(makeCtx('other', engine), baseParams);

    expect(result).toMatchObject({ dry_run: true, action: 'put_page' });
    expect(calls.map((call) => call.method)).toEqual(['executeRaw']);
  });

  test('null expected_source_id has the canonical missing-value semantics', async () => {
    const { engine, calls } = recordingEngine();
    const result = await putPage.handler(makeCtx('other', engine), {
      ...baseParams,
      expected_source_id: null,
    });

    expect(result).toMatchObject({ dry_run: true, action: 'put_page' });
    expect(calls.map((call) => call.method)).toEqual(['executeRaw']);
  });

  for (const invalid of ['', false, 0, '__all__', 'Other', 'other/source', {}, []]) {
    test(`rejects invalid expected_source_id ${JSON.stringify(invalid)} before engine work`, async () => {
      const { engine, calls } = recordingEngine();
      await expectOperationError(
        putPage.handler(makeCtx('other', engine), {
          ...baseParams,
          expected_source_id: invalid,
        }),
        'invalid_params',
      );
      expect(calls).toEqual([]);
    });
  }

  test('fails closed without reflecting an invalid effective source', async () => {
    const { engine, calls } = recordingEngine();
    const error = await expectOperationError(
      putPage.handler(makeCtx('__all__', engine), {
        ...baseParams,
        expected_source_id: 'default',
      }),
      'invalid_params',
    );

    expect(error.code).toBe('invalid_params');
    expect(error.message).not.toContain("effective write source '__all__'");
    expect(calls).toEqual([]);
  });
});
