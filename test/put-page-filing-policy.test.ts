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
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, OperationError } from '../src/core/operations.ts';
import { enforceStoredFilingPolicy, filingPolicyRejectionReason, parseSourceFilingPolicy } from '../src/core/filing-policy.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';
import { __resetGuardrailProvidersForTests, registerGuardrailProvider } from '../src/core/guardrails.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { finishUnpublishedFailure, publishMutation } from '../src/core/persistence/coordinator.ts';
import type { WriteAuthority } from '../src/core/persistence/model.ts';
import { preparePageMutation } from '../src/core/persistence/page-prepare.ts';

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
  __resetGuardrailProvidersForTests();
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

async function claimDurableOAuthWrite(sourceId: string, slug: string, content = PAGE_CONTENT) {
  const clientId = `filing-client-${randomUUID()}`;
  await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,client_secret_hash,scope,source_id,allowed_operations)
    VALUES($1,'filing-test','test-only','read write',$2,ARRAY['put_page'])`, [clientId, sourceId]);
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
  const authority: WriteAuthority = { version: 1, principal: { kind: 'oauth_client', id: clientId }, remote: true,
    excludePrivate: true, sourceId, sourceIncarnation: source.incarnation, scopes: ['read','write'],
    operations: ['put_page'], slugPrefixes: null };
  const admitted = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId,
    sourceIncarnation: source.incarnation, slug, pageId: null, requestId: randomUUID(), callerIntent: { slug, content }, intent: { slug, content } });
  const claimed = await claimNextWrite(engine, randomUUID());
  expect(claimed?.id).toBe(admitted.id);
  return claimed!;
}

describe('put_page source-owned filing policy', () => {
  test('accepts the production root .raw/ rule without allowing raw paths', async () => {
    const policy = parseSourceFilingPolicy(policyFor(['.raw/', 'people/']));
    expect(policy.directories).toContain('.raw/');

    for (const slug of ['.raw/', '.raw/page', '.raw/nested/page', '.RAW/page']) {
      expect(filingPolicyRejectionReason(slug, policy)).toBe('raw_path');
    }

    const source = await registerSource(['.raw/', 'people/']);
    const allowed = await putPage.handler(makeCtx({ sourceId: source.id }), {
      slug: 'people/alice-example',
      content: PAGE_CONTENT,
    });
    expect(allowed).toMatchObject({ status: 'created_or_updated' });
  });

  test('rejects non-literal hidden directory declarations as malformed', () => {
    for (const directory of ['.secret/', '.raw', '.RAW/']) {
      expect(() => parseSourceFilingPolicy(policyFor([directory]))).toThrow(
        'rules[0].directory has an invalid path segment',
      );
    }
  });

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

  test('dedup redirects are fenced before guardrail and audit side effects', async () => {
    const source = await registerSource(['people/']);
    const auditDir = path.join(tempRoot, `${source.id}-audit`);
    const content = '---\ntitle: Just a moment...\ntype: note\nid: legacy-victim\n---\n\nBody.';
    await engine.putPage('legacy/victim', {
      type: 'note', title: 'Just a moment...', compiled_truth: 'Body.', timeline: '',
      frontmatter: { id: 'legacy-victim' }, tags: [],
    }, { sourceId: source.id });

    let guardrailCalls = 0;
    registerGuardrailProvider({ id: 'dedup-preflight-observer', classify: () => { guardrailCalls++; } });
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const error = await expectPolicyError(makeCtx({ sourceId: source.id }), 'people/new-victim', content);
      expect(error.code).toBe('invalid_params');
      expect(error.message).not.toContain('legacy/victim');
    });
    expect(guardrailCalls).toBe(0);
    expect(fs.existsSync(auditDir)).toBe(false);
    expect(await engine.getPage('legacy/victim', { sourceId: source.id })).not.toBeNull();
    expect(await engine.getPage('people/new-victim', { sourceId: source.id })).toBeNull();
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

  test('rejects symlink, dangling, and oversized policy leaves', async () => {
    for (const mode of ['external', 'dangling', 'oversized'] as const) {
      const source = await registerSource(null);
      const leaf = path.join(source.root, 'skills', '_brain-filing-rules.json');
      if (mode === 'external') {
        const external = path.join(tempRoot, `${source.id}-outside.json`);
        fs.writeFileSync(external, JSON.stringify(policyFor(['people/'])));
        fs.symlinkSync(external, leaf);
      } else if (mode === 'dangling') {
        fs.symlinkSync(path.join(tempRoot, `${source.id}-missing.json`), leaf);
      } else {
        fs.writeFileSync(leaf, ' '.repeat(1024 * 1024 + 1));
      }
      const error = await expectPolicyError(makeCtx({ sourceId: source.id, dryRun: true }), 'people/alice');
      expect(error.code).toBe('invalid_params');
      expect(error.message).toContain('malformed');
    }
  });

  test('prefers the canonical owner binding over stale sources.local_path', async () => {
    const source = await registerSource(['people/']);
    const successor = path.join(tempRoot, `${source.id}-successor`);
    fs.mkdirSync(path.join(successor, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(successor, 'skills', '_brain-filing-rules.json'), JSON.stringify(policyFor(['companies/'])));
    await claimWorktree(engine, source.id, successor);

    const stalePathDecision = await expectPolicyError(makeCtx({ sourceId: source.id, dryRun: true }), 'people/alice');
    expect(stalePathDecision.message).toContain('undeclared_directory');
    const allowed = await putPage.handler(makeCtx({ sourceId: source.id, dryRun: true }), {
      slug: 'companies/acme', content: PAGE_CONTENT,
    });
    expect(allowed).toMatchObject({ dry_run: true, action: 'put_page' });
  });

  test('durable policy lookup outages requeue instead of terminally failing', async () => {
    const source = await registerSource(['people/']);
    const row = await claimDurableOAuthWrite(source.id, 'people/retry');
    const unavailable = await enforceStoredFilingPolicy({
      executeRaw: async () => { throw Object.assign(new Error('database unavailable'), { code: '08006' }); },
    } as any, row.authority, row.slug, row.source_id).catch(error => error as OperationError);
    expect(unavailable).toMatchObject({ code: 'filing_policy_unavailable' });

    const released = await finishUnpublishedFailure(engine, row, unavailable);
    expect(released).toMatchObject({ state: 'queued', blocked_reason: 'filing_policy_unavailable' });
  });

  test('durable validation runs before observable preparation effects', async () => {
    const source = await registerSource(['people/']);
    const row = await claimDurableOAuthWrite(source.id, 'people/no-leak');
    let effects = 0, applies = 0;
    const failed = await publishMutation(engine, row, {
      observedRevision: null,
      validate: async () => { throw new OperationError('invalid_params', 'policy changed'); },
      beforePublication: async () => { effects++; },
      apply: async () => { applies++; return {}; },
    });
    expect(failed).toMatchObject({ state: 'failed', error_code: 'invalid_params' });
    expect(effects).toBe(0);
    expect(applies).toBe(0);
  });

  test('prepared hard rejects emit guardrail and audit only after durable authorization', async () => {
    const source = await registerSource(['people/']);
    await engine.setConfig('content_sanity.junk_disposition', 'reject');
    const auditDir = path.join(tempRoot, `${source.id}-reject-audit`);
    let effects = 0;
    registerGuardrailProvider({ id: 'prepared-reject-observer', classify: () => { effects++; } });
    const content = '---\ntitle: Just a moment...\ntype: note\n---\n\nChecking your browser before accessing example.com.';
    const row = await claimDurableOAuthWrite(source.id, 'people/rejected', content);
    const prepared = await preparePageMutation(engine, row, { engine: 'pglite' });
    expect(prepared.beforePublication).toBeFunction();
    const failed = await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, () => publishMutation(engine, row, prepared));
    expect(failed).toMatchObject({ state: 'failed', error_code: 'invalid_params' });
    expect(effects).toBe(1);
    expect(fs.existsSync(auditDir)).toBe(true);
    expect(await engine.getPage('people/rejected', { sourceId: source.id })).toBeNull();
  });

  test('canonical file drift is rejected before observable effects', async () => {
    const source = await registerSource(['people/']);
    const row = await claimDurableOAuthWrite(source.id, 'people/file-race');
    const target = path.join(source.root, 'people', 'file-race.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'Uncoordinated bytes.');
    let effects = 0;
    const failed = await publishMutation(engine, row, { observedRevision: null,
      file: { root: source.root, path: target, content: PAGE_CONTENT, expectedBeforeHash: null },
      beforePublication: async () => { effects++; }, apply: async () => ({}) });
    expect(failed).toMatchObject({ state: 'conflict', error_code: 'source_changed' });
    expect(effects).toBe(0);
  });

  test('observable effects run outside the publication transaction locks', async () => {
    const source = await registerSource(['people/']);
    const row = await claimDurableOAuthWrite(source.id, 'people/unlocked-observer');
    let effects = 0;
    const committed = await publishMutation(engine, row, { observedRevision: null,
      beforePublication: async () => {
        await engine.transaction(tx => tx.executeRaw('SELECT id FROM persistence_requests WHERE id=$1::uuid FOR UPDATE', [row.id]));
        effects++;
      },
      apply: async () => ({ status: 'observed' }),
    });
    expect(committed.state).toBe('committed');
    expect(effects).toBe(1);
  });

  test('an invisible duplicate candidate is denied before effects', async () => {
    const source = await registerSource(null);
    await engine.putPage('private/existing', {
      type: 'note', title: 'Private', compiled_truth: 'Same body.', timeline: '',
      frontmatter: { id: 'private-id', visibility: 'private' }, tags: [],
    }, { sourceId: source.id });
    const row = await claimDurableOAuthWrite(source.id, 'people/new-private-id',
      '---\ntitle: New\ntype: note\nid: private-id\n---\n\nSame body.');

    let effects = 0;
    registerGuardrailProvider({ id: 'private-dedup-observer', classify: () => { effects++; } });
    await expect(preparePageMutation(engine, row, { engine: 'pglite' }))
      .rejects.toMatchObject({ code: 'permission_denied' });
    expect(effects).toBe(0);
    expect(await engine.getPage('people/new-private-id', { sourceId: source.id })).toBeNull();
    expect((await engine.getPage('private/existing', { sourceId: source.id }))?.compiled_truth).toContain('Same body.');
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
