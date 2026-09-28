import type { GBrainConfig } from '../config.ts';
import type { BrainEngine, TimelineBatchInput } from '../engine.ts';
import { parseTimelineEntries } from '../link-extraction.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import type { OperationContext } from '../ops/contract.ts';
import { OperationError } from '../ops/contract.ts';
import { authorizeStoredRequest, authorizeWrite, submissionAuthority } from './authority.ts';
import type { PreparedMutation } from './coordinator.ts';
import { digest } from './digest.ts';
import { currentVerifiedLocalWriter, registerLocalWriter } from './identity.ts';
import { admitWrite, getWriteRequest } from './journal.ts';
import { prepareManagedGraphLinks } from './links-preparation.ts';
import type { WriteAuthority, WriteRequest } from './model.ts';
import { managedPersistenceEnabled } from './ownership.ts';
import { assertPersistenceAccepting, waitForWrite, writeResponse } from './service.ts';

import { EXTRACTION_EXCLUDED_PAGE_TYPES, extractionPageTypePredicate } from '../extraction-scope.ts';

const MANAGED_GRAPH_EXCLUDED_TYPES = EXTRACTION_EXCLUDED_PAGE_TYPES;
const MANAGED_GRAPH_BATCH_SIZE = 25;
const MANAGED_GRAPH_MAX_ENDPOINT_RETRIES = 3;

interface ManagedGraphIntent extends Record<string, unknown> {
  kind: 'managed_graph_extract';
  expected_revision: string;
  extracted_at: string;
  extractor_version: string;
  include_frontmatter: boolean;
}

interface ManagedGraphSession {
  sourceId: string;
  incarnation: string;
  authority: WriteAuthority;
  config: GBrainConfig;
}

interface StaleManagedPage {
  id: number;
  slug: string;
  revision: string;
  updated_at_iso: string;
}

export interface ManagedGraphExtractionResult {
  linksCreated: number;
  timelineCreated: number;
  pagesProcessed: number;
  staleRemaining: number;
  skippedMissingTarget?: number;
  skippedCrossSource?: number;
}

function graphRequestId(sourceIncarnation: string, principal: WriteAuthority['principal'], page: StaleManagedPage,
  versionTs: string, includeFrontmatter: boolean): string {
  const hex = digest(['managed-graph-v1', principal, sourceIncarnation, page.id, page.revision, versionTs, includeFrontmatter]);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function graphRetryRequestId(priorRequestId: string, row: WriteRequest): string {
  const hex = digest(['managed-graph-retry-v1', priorRequestId, row.id, row.state, row.error_code ?? '']);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function stalePredicate(versionParam: number, qualifier = ''): string {
  const links = `${qualifier}links_extracted_at`;
  const updated = `${qualifier}updated_at`;
  return `(${links} IS NULL OR ${links} < $${versionParam}::timestamptz OR ${updated} > ${links})`;
}

async function countActionableStale(engine: BrainEngine, sourceId: string | undefined, versionTs: string): Promise<number> {
  const params: unknown[] = [];
  let source = '';
  if (sourceId) {
    params.push(sourceId);
    source = `AND p.source_id=$${params.length}`;
  }
  params.push(versionTs);
  const [row] = await engine.executeRaw<{ count: number }>(`SELECT count(*)::int AS count FROM pages p
    JOIN sources s ON s.id=p.source_id
    WHERE p.deleted_at IS NULL AND s.archived IS NOT TRUE AND ${extractionPageTypePredicate('p')} ${source}
      AND ${stalePredicate(params.length, 'p.')}`, params);
  return Number(row?.count ?? 0);
}

async function listActionableStale(engine: BrainEngine, sourceId: string, versionTs: string, afterId: number): Promise<StaleManagedPage[]> {
  return engine.executeRaw<StaleManagedPage>(`SELECT id,slug,knowledge_revision::text AS revision,
    to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_iso
    FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND id>$2
      AND ${extractionPageTypePredicate()}
      AND ${stalePredicate(3)} ORDER BY id LIMIT $4`, [sourceId, afterId, versionTs, MANAGED_GRAPH_BATCH_SIZE]);
}

async function managedGraphSession(engine: BrainEngine, sourceId: string): Promise<ManagedGraphSession> {
  assertPersistenceAccepting(engine);
  const caller = currentSubmissionAuthority();
  if ((caller && caller.kind !== 'application') || currentVerifiedLocalWriter()?.remote) {
    throw new OperationError('permission_denied', 'Graph maintenance requires a trusted local source-wide writer.');
  }
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean }>(
    'SELECT incarnation,archived FROM sources WHERE id=$1', [sourceId]);
  if (!source || source.archived) throw new OperationError('source_changed', 'The graph extraction source is unavailable.');
  if (!currentVerifiedLocalWriter()) await registerLocalWriter(engine, 'cli');
  const authority = await submissionAuthority({ engine, remote: false, sourceId } as OperationContext,
    'submit_job', sourceId, source.incarnation, '__managed_graph_extract__');
  if (authority.slugPrefixes || authority.restrictedNamespace || authority.delegated) {
    throw new OperationError('permission_denied', 'Graph maintenance requires a source-wide grant.');
  }
  return { sourceId, incarnation: source.incarnation, authority,
    config: { engine: engine.kind } as GBrainConfig };
}

async function sourceIdsForManagedGraph(engine: BrainEngine, versionTs: string, sourceId?: string): Promise<string[]> {
  if (sourceId) return [sourceId];
  const rows = await engine.executeRaw<{ id: string }>(`SELECT DISTINCT p.source_id AS id FROM pages p
    JOIN sources s ON s.id=p.source_id WHERE p.deleted_at IS NULL AND s.archived IS NOT TRUE
      AND ${extractionPageTypePredicate('p')} AND ${stalePredicate(1, 'p.')} ORDER BY p.source_id`, [versionTs]);
  return rows.map(row => row.id);
}

/**
 * Durable managed-brain counterpart of extractStaleFromDB. Generated atom and
 * extraction-receipt pages are intentionally outside this maintenance lane:
 * their graph provenance is installed by their originating coordinator flow,
 * and admitting permanent requests merely to advance a generic watermark
 * would turn extraction-lag noise into unbounded receipt growth.
 */
export async function extractManagedGraphStale(engine: BrainEngine, opts: {
  dryRun: boolean;
  sourceIdFilter?: string;
  catchUp: boolean;
  timeBudgetMs: number;
  versionTs: string;
  includeFrontmatter: boolean;
}): Promise<ManagedGraphExtractionResult> {
  if (!(await managedPersistenceEnabled(engine))) {
    throw new OperationError('writer_coordinator_required', 'Managed graph extraction requires an active persistence coordinator.');
  }
  const total = await countActionableStale(engine, opts.sourceIdFilter, opts.versionTs);
  if (opts.dryRun || total === 0) return { linksCreated: 0, timelineCreated: 0, pagesProcessed: 0, staleRemaining: total };

  const started = Date.now();
  let linksCreated = 0;
  let timelineCreated = 0;
  let pagesProcessed = 0;
  let skippedMissingTarget = 0;
  let skippedCrossSource = 0;
  for (const sourceId of await sourceIdsForManagedGraph(engine, opts.versionTs, opts.sourceIdFilter)) {
    const session = await managedGraphSession(engine, sourceId);
    let afterId = 0;
    for (;;) {
      const pages = await listActionableStale(engine, sourceId, opts.versionTs, afterId);
      if (!pages.length) break;
      for (const page of pages) {
        afterId = page.id;
        let requestId = graphRequestId(session.incarnation, session.authority.principal, page, opts.versionTs, opts.includeFrontmatter);
        const intent: ManagedGraphIntent = {
          kind: 'managed_graph_extract', expected_revision: page.revision,
          extracted_at: Date.parse(page.updated_at_iso) >= Date.parse(opts.versionTs) ? page.updated_at_iso : opts.versionTs,
          extractor_version: opts.versionTs, include_frontmatter: opts.includeFrontmatter,
        };
        let row = await getWriteRequest(engine, session.authority.principal, requestId);
        let endpointRetries = 0;
        while (row) {
          await authorizeStoredRequest(engine, row);
          if (row.operation !== 'submit_job' || row.source_id !== sourceId || row.slug !== page.slug || row.page_id !== page.id) {
            throw new OperationError('idempotency_conflict', 'The graph extraction request ID belongs to another accepted operation.');
          }
          // A committed receipt is the idempotent replay. Only an endpoint
          // revision race is safe to re-prepare automatically: permanent
          // failures and operator cancellation must not grow a new durable
          // receipt on every recurring sweep.
          if (row.state === 'committed') break;
          if (row.state !== 'conflict' || row.error_code !== 'endpoint_revision_conflict' ||
              endpointRetries >= MANAGED_GRAPH_MAX_ENDPOINT_RETRIES) break;
          endpointRetries++;
          requestId = graphRetryRequestId(requestId, row);
          row = await getWriteRequest(engine, session.authority.principal, requestId);
        }
        if (!row) {
          await authorizeWrite(engine, session.authority, 'submit_job', page.slug);
          row = await admitWrite(engine, {
            requestId, operation: 'submit_job', sourceId, sourceIncarnation: session.incarnation,
            slug: page.slug, pageId: page.id, authority: session.authority,
            principal: session.authority.principal, callerIntent: intent, intent,
            // Graph/timeline/watermark maintenance has no filesystem publication;
            // do not attach a worktree owner and accidentally require the
            // canonical checkout to be owned by this host.
            worktreeId: null, topologyGeneration: null,
          });
        }
        const finished = await waitForWrite(engine, row, session.config);
        const response = writeResponse(finished);
        linksCreated += Number(response.links_created ?? 0);
        timelineCreated += Number(response.timeline_created ?? 0);
        skippedMissingTarget += Number(response.skipped_missing_target ?? 0);
        skippedCrossSource += Number(response.skipped_cross_source ?? 0);
        pagesProcessed++;
      }
      if (!opts.catchUp && Date.now() - started > opts.timeBudgetMs) break;
    }
    if (!opts.catchUp && Date.now() - started > opts.timeBudgetMs) break;
  }
  return { linksCreated, timelineCreated, pagesProcessed, skippedMissingTarget, skippedCrossSource,
    staleRemaining: await countActionableStale(engine, opts.sourceIdFilter, opts.versionTs) };
}

export async function prepareManagedGraphMutation(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  const intent = row.intent as ManagedGraphIntent | null;
  if (!intent || intent.kind !== 'managed_graph_extract' || row.authority.remote ||
      row.authority.principal.kind !== 'local_cli' ||
      typeof intent.expected_revision !== 'string' || typeof intent.extracted_at !== 'string' ||
      typeof intent.extractor_version !== 'string' || typeof intent.include_frontmatter !== 'boolean') {
    throw new OperationError('permission_denied', 'Unsupported managed graph maintenance intent.');
  }
  await authorizeWrite(engine, row.authority, 'submit_job', row.slug);
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  if (!snapshot || snapshot.page.id !== row.page_id || snapshot.sourceIncarnation !== row.source_incarnation ||
      snapshot.revision !== intent.expected_revision) {
    throw new OperationError('revision_conflict', 'The graph extraction page changed before preparation.');
  }
  if ((MANAGED_GRAPH_EXCLUDED_TYPES as readonly string[]).includes(snapshot.page.type)) {
    throw new OperationError('invalid_params', 'Generated extraction pages are not eligible for managed graph maintenance.');
  }
  const links = await prepareManagedGraphLinks(engine, row.slug,
    { ...snapshot.page, frontmatter: snapshot.page.frontmatter ?? {} }, row.source_id,
    { includeFrontmatter: intent.include_frontmatter });
  const timelineRows: TimelineBatchInput[] = parseTimelineEntries(
    `${snapshot.page.compiled_truth}\n${snapshot.page.timeline}`,
  ).map(entry => ({ slug: row.slug, source_id: row.source_id, date: entry.date,
    source: entry.source, summary: entry.summary, detail: entry.detail || '' }));
  return {
    observedRevision: snapshot.revision,
    // Derived graph/timeline/watermark maintenance changes no canonical page
    // content. Suppress embedding/facts/Git effects for this receipt.
    noop: true,
    additionalPageKeys: links.pageKeys,
    apply: async tx => {
      const reconciled = await links.apply(tx);
      const timelineCreated = timelineRows.length
        ? await tx.addTimelineEntriesBatch(timelineRows, { auditSite: 'extract.stale' }) : 0;
      // The coordinator's revision guard is stronger than the legacy sweep's
      // read-time timestamp race check: canonical content cannot change between
      // preparation and this statement. Stamp from the database's exact
      // microsecond updated_at so postgres.js Date truncation cannot leave the
      // page perpetually stale on Postgres.
      const stamped = await tx.executeRaw(`UPDATE pages SET links_extracted_at=GREATEST(updated_at,$4::timestamptz)
        WHERE source_id=$1 AND id=$2 AND knowledge_revision::text=$3 RETURNING id`,
      [row.source_id, row.page_id, intent.expected_revision, intent.extractor_version]);
      if (stamped.length !== 1) throw new OperationError('revision_conflict', 'The graph extraction page changed before publication.');
      return { status: 'completed', kind: intent.kind, extractor_version: intent.extractor_version,
        links_created: reconciled.created, links_removed: reconciled.removed,
        timeline_created: timelineCreated, skipped_missing_target: reconciled.skipped_missing_target,
        skipped_cross_source: reconciled.skipped_cross_source };
    },
  };
}
