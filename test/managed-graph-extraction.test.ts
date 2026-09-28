import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GBrainConfig } from '../src/core/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractStaleFromDB } from '../src/commands/extract.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer, startPersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const engines: BrainEngine[] = [];
const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-graph-home-'));
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const pglite = new PGLiteEngine();
  await pglite.connect({ database_path: join(home, 'pglite') });
  await pglite.initSchema();
  engines.push(pglite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine);
    closePostgres = pg.close;
  }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) {
    await disposePersistenceConsumer(engine);
    if (engine.kind === 'pglite') await engine.disconnect();
  }
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
}, 120_000);

async function fixture(engine: BrainEngine, run: (sourceId: string) => Promise<void>) {
  const sourceId = `managed-graph-${randomUUID().slice(0, 8)}`;
  const root = mkdtempSync(join(tmpdir(), 'gbrain-managed-graph-root-'));
  mkdirSync(root, { recursive: true });
  try {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
    await claimWorktree(engine, sourceId, root);
    await engine.putPage('people/alice', {
      type: 'person', title: 'Alice', compiled_truth: 'Alice is an example person.', timeline: '', frontmatter: {},
    }, { sourceId });
    const foreignSourceId = `${sourceId}-foreign`;
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [foreignSourceId]);
    await engine.putPage('people/bob', {
      type: 'person', title: 'Bob', compiled_truth: 'Bob lives in another source.', timeline: '', frontmatter: {},
    }, { sourceId: foreignSourceId });
    await engine.setConfig('link_resolution.cross_source', 'true');
    await engine.putPage('notes/origin', {
      type: 'note', title: 'Origin', compiled_truth: 'Works with [[people/alice]], [[people/bob]], and [[people/missing]].',
      timeline: '- **2026-01-15** | Met with Alice', frontmatter: {},
    }, { sourceId });
    await engine.putPage('atoms/inert', {
      type: 'atom', title: 'Inert atom', compiled_truth: 'Generated atom without graph markup.', timeline: '', frontmatter: {},
    }, { sourceId });
    const archivedSourceId = `${sourceId}-archived`;
    await engine.executeRaw('INSERT INTO sources(id,name,archived) VALUES($1,$1,false)', [archivedSourceId]);
    await engine.putPage('notes/archived-stale', {
      type: 'note', title: 'Archived stale page', compiled_truth: 'Archived source content.', timeline: '', frontmatter: {},
    }, { sourceId: archivedSourceId });
    await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [archivedSourceId]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    startPersistenceConsumer(engine, { engine: engine.kind } as GBrainConfig);
    await run(sourceId);
  } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Failure modes pinned here before the implementation:
 * - the legacy stale sweep writes page watermarks outside the coordinator and is rejected;
 * - a successful managed pass must install derived links, timeline rows, and the watermark together;
 * - reconciliation must remove a dropped markdown edge instead of remaining add-only;
 * - generated atom/receipt pages must not consume durable requests merely to silence the global lag metric;
 * - a second pass must be idempotent and admit no new permanent request IDs.
 */
test('managed stale extraction reconciles actionable pages through durable coordinator requests', async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) await fixture(engine, async sourceId => {
      // The recurring autopilot job is intentionally unscoped ({ stale:true });
      // exercise that exact production route rather than the easier source filter.
      const first = await extractStaleFromDB(engine, {
        dryRun: false, jsonMode: true, quiet: true, catchUp: false,
      });
      expect(first.pagesProcessed).toBe(3);
      expect(first.staleRemaining).toBe(0);
      expect(first.linksCreated).toBe(2);
      expect(first.timelineCreated).toBe(1);
      expect(first.skippedMissingTarget).toBe(1);

      const links = await engine.getLinks('notes/origin', { sourceId });
      expect(links.map(link => link.to_slug).sort()).toEqual(['people/alice', 'people/bob']);
      expect(links.find(link => link.to_slug === 'people/bob')?.to_source_id).toBe(`${sourceId}-foreign`);
      expect(await engine.executeRaw(
        `SELECT t.id FROM timeline_entries t JOIN pages p ON p.id=t.page_id
         WHERE p.source_id=$1 AND p.slug='notes/origin' AND t.date='2026-01-15'`, [sourceId],
      )).toHaveLength(1);
      const stamps = await engine.executeRaw<{ slug: string; links_extracted_at: string | null }>(
        `SELECT slug,links_extracted_at FROM pages WHERE source_id=$1 ORDER BY slug`, [sourceId],
      );
      expect(stamps.find(row => row.slug === 'people/alice')?.links_extracted_at).not.toBeNull();
      expect(stamps.find(row => row.slug === 'notes/origin')?.links_extracted_at).not.toBeNull();
      expect(stamps.find(row => row.slug === 'atoms/inert')?.links_extracted_at).toBeNull();

      const accepted = await engine.executeRaw<{ kind: string; slug: string }>(
        `SELECT intent->>'kind' AS kind,slug FROM persistence_requests
         WHERE source_id=$1 AND intent->>'kind'='managed_graph_extract' ORDER BY sequence`, [sourceId],
      );
      expect(accepted.map(row => row.slug)).toEqual(['people/alice', 'notes/origin']);
      expect(await engine.executeRaw(
        `SELECT e.id FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
         WHERE r.intent->>'kind'='managed_graph_extract'`,
      )).toHaveLength(0);
      expect(await engine.executeRaw(
        `SELECT id FROM persistence_requests WHERE intent->>'kind'='managed_graph_extract' AND worktree_id IS NOT NULL`,
      )).toHaveLength(0);

      const origin = (await engine.readPageSnapshot('notes/origin', { sourceId }))!;
      await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.putPage('notes/origin', {
        type: origin.page.type, title: origin.page.title, compiled_truth: 'No graph reference remains.',
        timeline: origin.page.timeline, frontmatter: origin.page.frontmatter,
      }, { sourceId })));
      const second = await extractStaleFromDB(engine, {
        dryRun: false, jsonMode: true, quiet: true, catchUp: false,
      });
      expect(second.pagesProcessed).toBe(1);
      expect(second.staleRemaining).toBe(0);
      expect(await engine.getLinks('notes/origin', { sourceId })).toHaveLength(0);

      const requestsAfterSecond = await engine.executeRaw<{ n: number }>(
        `SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_graph_extract'`, [sourceId],
      );
      expect(Number(requestsAfterSecond[0]?.n)).toBe(3);
      const third = await extractStaleFromDB(engine, {
        dryRun: false, jsonMode: true, quiet: true, catchUp: false,
      });
      expect(third.pagesProcessed).toBe(0);
      expect(Number((await engine.executeRaw<{ n: number }>(
        `SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_graph_extract'`, [sourceId],
      ))[0]?.n)).toBe(3);
    });
  });
}, 120_000);
