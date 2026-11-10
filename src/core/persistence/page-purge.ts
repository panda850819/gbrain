import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.ts';
import type { BrainEngine } from '../engine.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { managedPersistenceEnabled } from './ownership.ts';
import { submitPageMutation } from './page-mutations.ts';

export interface PagePurgeFailure { source_id: string; slug: string; code: string; message: string }
export interface PagePurgeResult { slugs: string[]; count: number; failed: PagePurgeFailure[] }

/** Raised after every candidate was attempted; `result` keeps the committed purges. */
export class PagePurgeError extends Error {
  readonly code = 'page_purge_failed';
  constructor(readonly result: PagePurgeResult) {
    const first = result.failed[0];
    super(`${result.failed.length} expired tombstone(s) could not be purged; first ${first.source_id}:${first.slug}: ${first.code}: ${first.message}`);
    this.name = 'PagePurgeError';
  }
}

/**
 * Hard-delete tombstones older than the recovery window. A managed brain routes
 * each one through the coordinated `delete_page` purge (revision-checked, journaled,
 * artifact removal before the guarded delete); tombstones in archived sources are
 * left to the source lifecycle purge. Unmanaged brains keep the engine primitive.
 */
export async function purgeExpiredPages(engine: BrainEngine, olderThanHours: number): Promise<PagePurgeResult> {
  if (!await managedPersistenceEnabled(engine)) {
    const { slugs, count } = await engine.purgeDeletedPages(olderThanHours);
    return { slugs, count, failed: [] };
  }
  const hours = Math.max(0, Math.floor(olderThanHours));
  const candidates = await engine.executeRaw<{ source_id: string; slug: string }>(
    `SELECT p.source_id, p.slug FROM pages p JOIN sources s ON s.id = p.source_id
     WHERE p.deleted_at IS NOT NULL AND p.deleted_at < now() - make_interval(hours => $1::int) AND NOT s.archived
     ORDER BY p.deleted_at ASC, p.source_id ASC, p.slug ASC`, [hours]);
  const config = loadConfig() ?? { engine: engine.kind };
  const result: PagePurgeResult = { slugs: [], count: 0, failed: [] };
  for (const { source_id, slug } of candidates) {
    const snapshot = await engine.readPageSnapshot(slug, { sourceId: source_id, includeDeleted: true });
    if (!snapshot?.page.deleted_at) continue;
    const ctx = { engine, config, remote: false, dryRun: false, sourceId: source_id,
      logger: { info() {}, warn() {}, error() {} } } as OperationContext;
    try {
      await submitPageMutation(ctx, { operation: 'delete_page', waitMs: 30_000, params: {
        slug, source_id, purge: true, expected_revision: snapshot.revision, request_id: randomUUID() } });
      result.slugs.push(slug);
    } catch (error) {
      result.failed.push({ source_id, slug,
        code: error instanceof OperationError ? error.code : 'storage_error',
        message: error instanceof Error ? error.message : String(error) });
    }
  }
  result.count = result.slugs.length;
  if (result.failed.length > 0) throw new PagePurgeError(result);
  return result;
}

/** The purge phase keeps the committed purges and reports the failure instead of losing the counts. */
export async function settleExpiredPagePurge(engine: BrainEngine, olderThanHours: number): Promise<{ result: PagePurgeResult; error?: PagePurgeError }> {
  try { return { result: await purgeExpiredPages(engine, olderThanHours) }; }
  catch (error) { if (error instanceof PagePurgeError) return { result: error.result, error }; throw error; }
}
