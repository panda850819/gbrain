/**
 * The autopilot purge phase hard-deletes expired tombstones on a managed brain
 * through the persistence coordinator, and a failing maintenance phase fails the
 * global-maintenance job instead of completing it.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runCycle, LAST_GLOBAL_AT_KEY } from '../src/core/cycle.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
let schemaVersion: string;
const home = mkdtempSync(join(tmpdir(), 'gbrain-purge-guard-'));
const page = (body: string) => ({ type: 'note', title: 'Example', compiled_truth: body, timeline: '', frontmatter: {} });

beforeAll(async () => {
  const local = new PGLiteEngine();
  await local.connect({}); await local.initSchema(); engines.push(local);
  schemaVersion = (await local.getConfig('version'))!;
  const pg = process.env.DATABASE_URL;
  if (pg) {
    assertSafeE2eDatabaseUrl(pg);
    const isolated = await isolatedPersistencePostgres(pg);
    closePostgres = isolated.close; engines.push(isolated.engine);
  }
}, 120_000);
afterAll(async () => {
  const [local] = engines;
  await disposePersistenceConsumer(local); await local.disconnect();
  if (engines[1]) await disposePersistenceConsumer(engines[1]);
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
}, 60_000);

async function reset(engine: BrainEngine): Promise<void> {
  await disposePersistenceConsumer(engine);
  if (engine instanceof PGLiteEngine) { await resetPgliteState(engine); await engine.setConfig('version', schemaVersion); return; }
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('DELETE FROM pages');
}
async function tombstone(engine: BrainEngine, slug: string, hoursAgo: number): Promise<void> {
  await engine.putPage(slug, page(`${slug} body`));
  await engine.softDeletePage(slug);
  await engine.executeRaw(`UPDATE pages SET deleted_at = now() - make_interval(hours => $2::int) WHERE slug = $1`, [slug, hoursAgo]);
}
async function slugs(engine: BrainEngine): Promise<string[]> {
  return (await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages ORDER BY slug')).map(r => r.slug);
}
async function globalMaintenanceHandler(engine: BrainEngine) {
  let handler: ((job: unknown) => Promise<unknown>) | undefined;
  await registerBuiltinHandlers({ register: (name: string, fn: (job: unknown) => Promise<unknown>) => {
    if (name === 'autopilot-global-maintenance') handler = fn;
  } } as never, engine);
  return handler!;
}

describe('purge phase under the managed writer guard', () => {
  test('hard-deletes expired tombstones through the coordinator', () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await reset(engine);
      await engine.putPage('notes/live', page('live body'));
      await tombstone(engine, 'notes/expired', 100);
      await tombstone(engine, 'notes/recent', 1);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      try {
        await expect(engine.purgeDeletedPages(72)).rejects.toThrow('writer_coordinator_required');
        const report = await runCycle(engine, { brainDir: null, phases: ['purge'] });
        const phase = report.phases.find(p => p.phase === 'purge')!;
        expect(phase.error).toBeUndefined();
        expect(phase.status).toBe('ok');
        expect(phase.details.purged_pages_count).toBe(1);
        expect(phase.details.purged_page_slugs).toEqual(['notes/expired']);
        expect(await slugs(engine)).toEqual(['notes/live', 'notes/recent']);
        const receipts = await engine.executeRaw<{ operation: string; state: string }>(
          `SELECT operation, state FROM persistence_requests WHERE slug = 'notes/expired'`);
        expect(receipts).toEqual([{ operation: 'delete_page', state: 'committed' }]);
      } finally {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      }
    }
  }), 120_000);
});

describe('global maintenance job status', () => {
  test('a failed purge phase fails the job instead of completing it', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const engine = engines[0];
    await reset(engine);
    await tombstone(engine, 'notes/expired', 100);
    const handler = await globalMaintenanceHandler(engine);
    const purge = spyOn(engine, 'purgeDeletedPages').mockRejectedValue(
      new OperationError('writer_coordinator_required', 'canonical writer must use the persistence coordinator'));
    try {
      const outcome = await handler({ id: 9101, data: { phases: ['purge'], repoPath: null } }).then(
        value => ({ completed: true as const, value }), error => ({ completed: false as const, error }));
      expect(outcome.completed).toBe(false);
      if (outcome.completed) return;
      expect(outcome.error.name).toBe('UnrecoverableError');
      expect(String(outcome.error.message)).toContain('purge');
      const phase = outcome.error.report.phases.find((p: { phase: string }) => p.phase === 'purge');
      expect(phase.status).toBe('fail');
    } finally {
      purge.mockRestore();
    }
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).toBeNull();
    expect(await slugs(engine)).toEqual(['notes/expired']);
  }), 60_000);
});
