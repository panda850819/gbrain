import type { BrainEngine } from '../core/engine.ts';
import { managedPersistenceEnabled } from '../core/persistence/ownership.ts';
import { extractManagedGraphStale, type ManagedGraphExtractionResult } from '../core/persistence/graph-maintenance.ts';

/** Keep the size-ratcheted extract façade free of persistence orchestration. */
export async function maybeExtractManagedGraphStale(engine: BrainEngine, opts: {
  dryRun: boolean;
  jsonMode: boolean;
  quiet?: boolean;
  includeFrontmatter: boolean;
  sourceIdFilter?: string;
  catchUp: boolean;
  timeBudgetMs: number;
  versionTs: string;
}): Promise<ManagedGraphExtractionResult | null> {
  if (!(await managedPersistenceEnabled(engine))) return null;
  const result = await extractManagedGraphStale(engine, opts);
  if (opts.quiet) return result;
  if (opts.jsonMode) {
    process.stdout.write(JSON.stringify({
      action: opts.dryRun ? 'extract_stale_dry_run' : 'extract_stale_done',
      managed: true,
      ...(opts.dryRun ? { stale_pages: result.staleRemaining } : {}),
      links_created: result.linksCreated,
      timeline_created: result.timelineCreated,
      pages_processed: result.pagesProcessed,
      stale_remaining: result.staleRemaining,
      skipped_missing_target: result.skippedMissingTarget ?? 0,
      skipped_cross_source: result.skippedCrossSource ?? 0,
    }) + '\n');
  } else if (opts.dryRun) {
    console.log(`(dry run) ${result.staleRemaining} actionable page(s) need managed link/timeline extraction.`);
  } else {
    console.log(`Managed extract --stale: ${result.linksCreated} link(s) + ${result.timelineCreated} timeline entr(ies) from ${result.pagesProcessed} page(s); ${result.staleRemaining} actionable page(s) remain.`);
    if ((result.skippedMissingTarget ?? 0) > 0) console.log(`Skipped ${result.skippedMissingTarget} candidate(s) whose target page does not exist.`);
    if ((result.skippedCrossSource ?? 0) > 0) console.log(`Skipped ${result.skippedCrossSource} cross-source candidate(s) — target exists outside the allowed source scope.`);
  }
  return result;
}
