/**
 * Source-owned remote put_page filing policy (#28).
 *
 * A policy is read from the target source's own checkout, so these tests use
 * two temporary source roots rather than the bundled skills directory. The
 * rejected cases run through the real operation handler and assert dry-run
 * parity / no persistence; local and legacy no-policy compatibility are
 * covered explicitly.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, OperationError } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';

const putPage = operations.find((operation) => operation.name === 'put_page')!;
const PAGE_CONTENT = '---\ntitle: Filing test\ntype: note\n---\n\nBody.';

let engine: PGLiteEngine;
let tempRoot: string;
let sourceNumber = 0;

beforeAll(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-filing-policy-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  resetGateway();
});

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...overrides,
  };
}

function policyFor(directories: string[], allowedTopicDomains?: string[]): Record<string, unknown> {
  return {
    version: '1.0.0',
    rules: directories.map((directory) => ({ directory })),
    ...(allowedTopicDomains ? { topic_domains: { allowed: allowedTopicDomains } } : {}),
  };
}

async function registerSource(
  directories: string[] | null,
  allowedTopicDomains?: string[],
): Promise<{ id: string; root: string }> {
  const id = `policy-${++sourceNumber}`;
  const root = path.join(tempRoot, id);
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
  if (directories) {
    fs.writeFileSync(
      path.join(root, 'skills', '_brain-filing-rules.json'),
      JSON.stringify(policyFor(directories, allowedTopicDomains)),
    );
  }
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, '{}'::jsonb)`,
    [id, root],
  );
  return { id, root };
}

async function expectPolicyError(
  ctx: OperationContext,
  slug: string,
  content = PAGE_CONTENT,
): Promise<OperationError> {
  try {
    await putPage.handler(ctx, { slug, content });
  } catch (error) {
    expect(error).toBeInstanceOf(OperationError);
    return error as OperationError;
  }
  throw new Error(`expected filing policy rejection for ${slug}`);
}

describe('put_page source-owned filing policy', () => {
  test('allows only declared source directories and rejects bare/undeclared paths', async () => {
    const source = await registerSource(['people/', 'custom/']);
    const ctx = makeCtx({ sourceId: source.id });

    const allowed = await putPage.handler(ctx, {
      slug: 'custom/source-specific-page',
      content: PAGE_CONTENT,
    });
    expect(allowed).toMatchObject({ status: 'created_or_updated' });
    expect(await engine.getPage('custom/source-specific-page', { sourceId: source.id })).not.toBeNull();

    for (const slug of ['bare-root', 'wiki/legacy-page', 'topics/finance/market']) {
      const error = await expectPolicyError(ctx, slug);
      expect(error.code).toBe('invalid_params');
      expect(error.suggestion).toContain('inbox/');
      expect(await engine.getPage(slug, { sourceId: source.id })).toBeNull();
    }
  });

  test('enforces immediate topic domains and rejects raw sidecar paths', async () => {
    const source = await registerSource(['topics/', 'people/'], ['allowed']);
    const ctx = makeCtx({ sourceId: source.id });

    await putPage.handler(ctx, {
      slug: 'topics/allowed/deep-topic',
      content: PAGE_CONTENT,
    });
    expect(await engine.getPage('topics/allowed/deep-topic', { sourceId: source.id })).not.toBeNull();

    for (const slug of ['topics/blocked/page', 'topics/allowed.raw/source', 'people/alice.raw/source']) {
      const error = await expectPolicyError(ctx, slug);
      expect(error.code).toBe('invalid_params');
      expect(error.message).toContain('filing policy');
      expect(error.suggestion).toContain('inbox/');
    }
  });

  test('an explicitly declared wiki/ namespace is still rejected', async () => {
    const source = await registerSource(['wiki/', 'people/']);
    const error = await expectPolicyError(makeCtx({ sourceId: source.id }), 'wiki/legacy-page');
    expect(error.code).toBe('invalid_params');
    expect(error.message).toContain('wiki_namespace');
    expect(error.suggestion).toContain('inbox/');
  });

  test('normalizes mixed-case directory declarations with and without a trailing slash', async () => {
    const source = await registerSource(['PeOpLe/', 'Companies']);
    await putPage.handler(makeCtx({ sourceId: source.id }), {
      slug: 'people/alice-example',
      content: PAGE_CONTENT,
    });
    await putPage.handler(makeCtx({ sourceId: source.id }), {
      slug: 'companies/acme-example',
      content: PAGE_CONTENT,
    });
    expect(await engine.getPage('people/alice-example', { sourceId: source.id })).not.toBeNull();
    expect(await engine.getPage('companies/acme-example', { sourceId: source.id })).not.toBeNull();
  });

  test('reads the policy from ctx.sourceId, not the bundled/global rules', async () => {
    const sourceA = await registerSource(['only-a/']);
    const sourceB = await registerSource(['only-b/']);

    await putPage.handler(makeCtx({ sourceId: sourceA.id }), {
      slug: 'only-a/page',
      content: PAGE_CONTENT,
    });
    await expectPolicyError(makeCtx({ sourceId: sourceA.id }), 'only-b/page');

    await putPage.handler(makeCtx({ sourceId: sourceB.id }), {
      slug: 'only-b/page',
      content: PAGE_CONTENT,
    });
    expect(await engine.getPage('only-b/page', { sourceId: sourceB.id })).not.toBeNull();
  });

  test('missing policy preserves remote compatibility, while malformed policy fails closed', async () => {
    const noPolicy = await registerSource(null);
    const legacy = await putPage.handler(makeCtx({ sourceId: noPolicy.id }), {
      slug: 'bare-root-legacy',
      content: PAGE_CONTENT,
    });
    expect(legacy).toMatchObject({ status: 'created_or_updated' });

    const malformed = await registerSource(['people/']);
    fs.writeFileSync(
      path.join(malformed.root, 'skills', '_brain-filing-rules.json'),
      JSON.stringify({ rules: [{ directory: 42 }]}),
    );
    const error = await expectPolicyError(makeCtx({ sourceId: malformed.id }), 'people/alice');
    expect(error.code).toBe('invalid_params');
    expect(error.message).toContain('malformed');
    expect(error.suggestion).toContain('inbox/');
    expect(await engine.getPage('people/alice', { sourceId: malformed.id })).toBeNull();
  });

  test('source-policy lookup errors fail closed for remote callers', async () => {
    const failingEngine = {
      executeRaw: async () => { throw new Error('database unavailable'); },
    } as unknown as OperationContext['engine'];
    const error = await expectPolicyError(
      makeCtx({ engine: failingEngine, dryRun: true, sourceId: 'policy-source' }),
      'people/alice',
    );
    expect(error.code).toBe('invalid_params');
    expect(error.message).toContain('could not be loaded');
    expect(error.suggestion).toContain('inbox/');

    const missingSourceEngine = {
      executeRaw: async () => [],
    } as unknown as OperationContext['engine'];
    const missing = await expectPolicyError(
      makeCtx({ engine: missingSourceEngine, dryRun: true, sourceId: 'missing-source' }),
      'people/alice',
    );
    expect(missing.code).toBe('invalid_params');
    expect(missing.message).toContain('could not be loaded');
    expect(missing.suggestion).toContain('inbox/');

    const unavailableEngine = {} as OperationContext['engine'];
    const unavailable = await expectPolicyError(
      makeCtx({ engine: unavailableEngine, dryRun: true, sourceId: 'policy-source' }),
      'people/alice',
    );
    expect(unavailable.code).toBe('invalid_params');
    expect(unavailable.message).toContain('could not be loaded');
    expect(unavailable.suggestion).toContain('inbox/');

    const malformedRowEngine = {
      executeRaw: async () => [{}],
    } as unknown as OperationContext['engine'];
    const malformedRow = await expectPolicyError(
      makeCtx({ engine: malformedRowEngine, dryRun: true, sourceId: 'policy-source' }),
      'people/alice',
    );
    expect(malformedRow.code).toBe('invalid_params');
    expect(malformedRow.message).toContain('could not be loaded');
    expect(malformedRow.suggestion).toContain('inbox/');

    for (const localPath of [null, '']) {
      const pathlessEngine = {
        executeRaw: async () => [{ local_path: localPath }],
      } as unknown as OperationContext['engine'];
      const legacy = await putPage.handler(
        makeCtx({ engine: pathlessEngine, dryRun: true, sourceId: 'pathless-source' }),
        { slug: 'anything/goes', content: PAGE_CONTENT },
      );
      expect(legacy).toMatchObject({ dry_run: true, action: 'put_page' });
    }
  });

  test('missing source checkout fails closed, while a legacy checkout without skills/ stays compatible', async () => {
    const missingRoot = await registerSource(['people/']);
    fs.rmSync(missingRoot.root, { recursive: true, force: true });
    const rootError = await expectPolicyError(
      makeCtx({ sourceId: missingRoot.id, dryRun: true }),
      'people/alice',
    );
    expect(rootError.code).toBe('invalid_params');
    expect(rootError.message).toContain('could not be loaded');
    expect(rootError.suggestion).toContain('inbox/');

    const missingSkills = await registerSource(['people/']);
    fs.rmSync(path.join(missingSkills.root, 'skills'), { recursive: true, force: true });
    const legacy = await putPage.handler(makeCtx({ sourceId: missingSkills.id }), {
      slug: 'bare-root-legacy-no-skills',
      content: PAGE_CONTENT,
    });
    expect(legacy).toMatchObject({ status: 'created_or_updated' });
  });

  test('dedup redirects are checked against the resolved filing path', async () => {
    const source = await registerSource(['people/']);
    const victimContent = '---\ntitle: Legacy victim\ntype: note\nid: legacy-victim\n---\n\nBody.';
    await putPage.handler(makeCtx({ sourceId: source.id, remote: false }), {
      slug: 'legacy/victim',
      content: victimContent,
    });

    const error = await expectPolicyError(
      makeCtx({ sourceId: source.id }),
      'people/new-victim',
      victimContent,
    );
    expect(error.code).toBe('invalid_params');
    expect(error.suggestion).toContain('inbox/');
    expect(await engine.getPage('legacy/victim', { sourceId: source.id })).not.toBeNull();
    expect(await engine.getPage('people/new-victim', { sourceId: source.id })).toBeNull();
  });

  test('protected subagent fences keep their existing namespace contract', async () => {
    const source = await registerSource(['people/']);
    const result = await putPage.handler(makeCtx({
      sourceId: source.id,
      dryRun: true,
      viaSubagent: true,
      subagentId: 42,
      allowedSlugPrefixes: ['wiki/originals/*'],
    }), {
      slug: 'wiki/originals/agent-output',
      content: PAGE_CONTENT,
    });
    expect(result).toMatchObject({ dry_run: true, action: 'put_page' });
  });

  test('dry-run has the same policy decision and local CLI bypasses it', async () => {
    const source = await registerSource(['people/']);
    const remoteDryRun = makeCtx({ sourceId: source.id, dryRun: true });
    const dryRunError = await expectPolicyError(remoteDryRun, 'undeclared/page');
    expect(dryRunError.code).toBe('invalid_params');
    expect(await engine.getPage('undeclared/page', { sourceId: source.id })).toBeNull();

    const dryRunAllowed = await putPage.handler(remoteDryRun, {
      slug: 'people/alice',
      content: PAGE_CONTENT,
    });
    expect(dryRunAllowed).toMatchObject({ dry_run: true, action: 'put_page' });

    const local = await putPage.handler(makeCtx({ sourceId: source.id, remote: false }), {
      slug: 'bare-root-local',
      content: PAGE_CONTENT,
    });
    expect(local).toMatchObject({ status: 'created_or_updated' });
    expect(await engine.getPage('bare-root-local', { sourceId: source.id })).not.toBeNull();
  });

  test('existing subagent and OAuth fences still win before filing policy', async () => {
    const source = await registerSource(['people/']);
    const subagentError = await expectPolicyError(
      makeCtx({
        sourceId: source.id,
        dryRun: true,
        viaSubagent: true,
        subagentId: 42,
        allowedSlugPrefixes: ['wiki/agents/42/*'],
      }),
      'people/alice',
    );
    expect(subagentError.code).toBe('permission_denied');
    expect(subagentError.message).toContain('allow-list');

    const oauthError = await expectPolicyError(
      makeCtx({
        sourceId: source.id,
        dryRun: true,
        auth: { token: 't', clientId: 'c', scopes: [], boundSlugPrefixes: ['people/allowed/'] },
      }),
      'people/other',
    );
    expect(oauthError.code).toBe('permission_denied');
    expect(oauthError.message).toContain('bound_slug_prefixes');
  });
});
