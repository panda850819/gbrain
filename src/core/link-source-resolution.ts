import type { BrainEngine } from './engine.ts';
import type { LinkCandidate } from './link-extraction.ts';
import { isValidSourceId } from './source-id.ts';

/**
 * v0.42.7 (#1696): pure cross-source resolution for one extracted link
 * candidate. Validates both endpoints exist (else the batch JOIN drops the row),
 * then picks from_source_id / to_source_id: prefer the origin page's source,
 * fall back to 'default', else skip (never push a wrong-source edge). Shared
 * by extractLinksFromDB and extractStaleFromDB so the F10 multi-source
 * resolution and the source-isolation policy can't drift.
 *
 * v0.46.28.0 (#2589): the failure case now carries a `reason` instead of a
 * bare `null`. A target that resolves via `global_basename` to a page that
 * exists ONLY in a source other than the origin's or 'default' was
 * indistinguishable from a genuinely-missing target — both silently dropped
 * the candidate and both counted (misleadingly) as "target page doesn't
 * exist". This stays default-deny by design: cross-source edges remain
 * unwritten (source isolation — see CLAUDE.md), but callers can now
 * attribute the drop correctly instead of reporting a wrong reason.
 *
 * #3478: only a federated origin source may fall back to 'default'; when
 * `allowCrossSource` is false both endpoints must live in the page's own
 * source, else skip with reason 'cross_source' (never push a wrong-source
 * edge).
 *
 * #3908: `opts.crossSource` (the `link_resolution.cross_source` config flag)
 * is the explicit operator opt-in — it supersedes the ambient federation
 * gate, which only exists to stop DEFAULT-ON silent cross-source regrowth.
 * With it on, a cross-source-only candidate resolves with the
 * lexicographically smallest matching source (deterministic, so repeated
 * extracts and both engines converge on the same edge under the
 * (source_id, slug) composite key) instead of dropping with 'cross_source'.
 *
 * #4611: the fallback lane compares against `opts.defaultSourceId` (the
 * configured `sources.default`, resolved once per run by the callers via
 * resolveLinkFallbackDefault) instead of the LITERAL string 'default'.
 * Renaming the brain's default source no longer silently kills the
 * cross-source fallback. Omitted → 'default' (back-compat).
 */
export type CandidateSourceResolution =
  | { ok: true; fromSlug: string; fromSourceId: string; toSourceId: string }
  | { ok: false; reason: 'missing_target' | 'missing_from' | 'cross_source' };

/**
 * #4611: resolve the source id the cross-source link fallback compares
 * against. Reads the operator-configured `sources.default` (same key the
 * write-routing ladder in source-resolver.ts tier 5 reads), silently
 * falling back to the seeded literal 'default' on unset/invalid/config
 * errors — extraction must never fail on a bad config row.
 */
export async function resolveLinkFallbackDefault(
  engine: Pick<BrainEngine, 'getConfig'>,
): Promise<string> {
  try {
    const v = await engine.getConfig('sources.default');
    if (v && isValidSourceId(v)) return v;
  } catch {
    // Best-effort read; the seeded literal below is the safe terminal.
  }
  return 'default';
}

export function resolveCandidateSources(
  c: LinkCandidate,
  pageSlug: string,
  pageSourceId: string,
  allSlugs: Set<string>,
  slugToSources: Map<string, string[]>,
  allowCrossSource: boolean,
  opts: { crossSource?: boolean; defaultSourceId?: string } = {},
): CandidateSourceResolution {
  const fromSlug = c.fromSlug ?? pageSlug;
  if (!allSlugs.has(c.targetSlug)) return { ok: false, reason: 'missing_target' };
  if (!allSlugs.has(fromSlug)) return { ok: false, reason: 'missing_from' };
  const fromSources = slugToSources.get(fromSlug) ?? [];
  const targetSources = slugToSources.get(c.targetSlug) ?? [];
  if (c.targetSourceId) {
    if (!targetSources.includes(c.targetSourceId)) return { ok: false, reason: 'missing_target' };
    if (!fromSources.includes(pageSourceId)) return { ok: false, reason: 'missing_from' };
    if (c.targetSourceId !== pageSourceId && !allowCrossSource && !opts.crossSource) return { ok: false, reason: 'cross_source' };
    return { ok: true, fromSlug, fromSourceId: pageSourceId, toSourceId: c.targetSourceId };
  }
  if (!allowCrossSource && !opts.crossSource) {
    if (!fromSources.includes(pageSourceId) || !targetSources.includes(pageSourceId)) {
      // #3478 isolation × #2589 counting: both endpoints exist but not in
      // the origin's own source — a counted cross-source drop, never an edge.
      return { ok: false, reason: 'cross_source' };
    }
    return { ok: true, fromSlug, fromSourceId: pageSourceId, toSourceId: pageSourceId };
  }
  // #4611: follow the CONFIGURED default source, not the literal 'default'.
  const defaultSourceId = opts.defaultSourceId ?? 'default';
  const fromSourceId = fromSources.includes(pageSourceId) ? pageSourceId
    : (fromSources.includes(defaultSourceId) ? defaultSourceId : fromSources[0]);
  let toSourceId: string;
  if (targetSources.includes(fromSourceId)) {
    toSourceId = fromSourceId;
  } else if (targetSources.includes(defaultSourceId)) {
    toSourceId = defaultSourceId;
  } else if (targetSources.length > 0) {
    // #2589: the target exists ONLY in other sources. Historically this was
    // a silent null (indistinguishable from a missing endpoint — multi-source
    // graphs went sparse with dead_links stuck at 0). Behind the opt-in
    // `link_resolution.cross_source` flag the edge is allowed with a
    // DETERMINISTIC pick (lexicographically smallest source, so repeated
    // extracts and both engines converge on the same edge under the
    // (source_id, slug) composite key); off, callers get the distinguishable
    // 'cross_source' reason to COUNT the drop instead of burying it.
    if (!opts.crossSource) return { ok: false, reason: 'cross_source' };
    // Allocation-free deterministic min (bulk loops call this per candidate;
    // in the motivating federated topology most candidates hit this branch).
    let min = targetSources[0];
    for (const s of targetSources) if (s < min) min = s;
    toSourceId = min;
  } else {
    return { ok: false, reason: 'cross_source' };
  }
  return { ok: true, fromSlug, fromSourceId, toSourceId };
}
