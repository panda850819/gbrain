import type { BrainEngine, LinkBatchInput } from '../engine.ts';
import type { ParsedPage } from '../import-file.ts';
import {
  extractPageLinks, isCrossSourceLinksEnabled, isGlobalBasenameEnabled, makeResolver,
} from '../link-extraction.ts';
import { loadActivePackForLocalEngine } from '../schema-pack/best-effort.ts';
import { loadAllSources } from '../sources-load.ts';
import type { LinkPageMetadata } from '../link-reconciliation.ts';
import { resolveCandidateSources, resolveLinkFallbackDefault } from '../link-source-resolution.ts';

function capturedLinkEndpoints(links: LinkBatchInput[], metadata: ReadonlyMap<string, LinkPageMetadata>, origin: { slug: string; sourceId: string }) {
  const keys = new Set(links.flatMap(link => [
    `${link.from_source_id ?? 'default'}\0${link.from_slug}`,
    `${link.to_source_id ?? 'default'}\0${link.to_slug}`,
  ]));
  return [...keys].flatMap(key => {
    const endpoint = metadata.get(key);
    // A new put_page origin is not present in the preparation-time metadata
    // snapshot yet; replaceDerivedLinks verifies it with the post-canonical
    // publication snapshot. Every non-origin endpoint must be captured.
    if (!endpoint && key === `${origin.sourceId}\0${origin.slug}`) return [];
    if (!endpoint) throw new Error('A derived link endpoint was not captured during type resolution');
    return [{ slug: endpoint.slug, sourceId: endpoint.source_id, revision: endpoint.knowledge_revision }];
  });
}

/** Resolve outside transactions; install only under the originating page guard. */
export async function prepareAutomaticLinks(engine: BrainEngine, slug: string,
  page: Pick<ParsedPage, 'type' | 'compiled_truth' | 'timeline' | 'frontmatter'>, sourceId: string,
  opts?: { includeFrontmatter?: boolean }) {
  const includeFrontmatter = opts?.includeFrontmatter !== false;
  const { candidates, unresolved } = await extractPageLinks(slug, `${page.compiled_truth}\n${page.timeline}`,
    page.frontmatter, page.type, makeResolver(engine, { mode: 'live', sourceId }), {
      skipFrontmatter: !includeFrontmatter,
      globalBasename: await isGlobalBasenameEnabled(engine),
      pack: (await loadActivePackForLocalEngine(engine))?.manifest ?? null,
    });
  const previous = [...await engine.getLinks(slug, { sourceId }), ...await engine.getBacklinks(slug, { sourceId })];
  const keys = [...new Set([...candidates.flatMap(c => [c.targetSlug, c.fromSlug ?? slug]),
    ...previous.flatMap(l => [l.from_slug, l.to_slug])])].sort();
  return { pageKeys: keys.map(target => ({ sourceId, slug: target })), apply: async (tx: BrainEngine) => {
    const present = new Set((keys.length ? await tx.executeRaw<{ slug: string }>(
      'SELECT slug FROM pages WHERE source_id=$1 AND slug=ANY($2::text[])', [sourceId, keys]) : []).map(row => row.slug));
    const valid = candidates.filter(c => present.has(c.targetSlug) && present.has(c.fromSlug ?? slug));
    const outgoing = await tx.getLinks(slug, { sourceId });
    const incoming = includeFrontmatter
      ? (await tx.getBacklinks(slug, { sourceId })).filter(l => l.link_source === 'frontmatter' && l.origin_slug === slug)
      : [];
    const managed = outgoing.filter(l => l.link_source == null || ['markdown', 'wikilink-resolved'].includes(l.link_source)
      || includeFrontmatter && l.link_source === 'frontmatter' && l.origin_slug === slug);
    const key = (from: string, to: string, type: string, origin: string | null | undefined) => JSON.stringify([from, to, type, origin ?? 'markdown']);
    const existing = new Map([...managed, ...incoming].map(l => [key(l.from_slug, l.to_slug, l.link_type, l.link_source), l]));
    const wanted = new Set<string>();
    let created = 0, removed = 0;
    for (const c of valid) {
      const from = c.fromSlug ?? slug;
      const linkSource = from === slug ? c.linkSource ?? 'markdown' : 'frontmatter';
      const identity = key(from, c.targetSlug, c.linkType, linkSource);
      if (wanted.has(identity)) continue;
      wanted.add(identity);
      await tx.addLink(from, c.targetSlug, c.context, c.linkType, linkSource, c.originSlug, c.originField,
        { fromSourceId: sourceId, toSourceId: sourceId, originSourceId: sourceId });
      if (!existing.has(identity)) created++;
    }
    for (const [identity, link] of existing) if (!wanted.has(identity)) {
      await tx.removeLink(link.from_slug, link.to_slug, link.link_type, link.link_source ?? undefined,
        { fromSourceId: sourceId, toSourceId: sourceId });
      removed++;
    }
    return { created, removed, errors: 0, unresolved_count: unresolved.length };
  } };
}

export async function prepareManagedGraphLinks(engine: BrainEngine, slug: string,
  page: Pick<ParsedPage, 'type' | 'compiled_truth' | 'timeline' | 'frontmatter'>, sourceId: string,
  opts?: { includeFrontmatter?: boolean }) {
  const includeFrontmatter = opts?.includeFrontmatter !== false;
  const [globalBasename, pack, crossSource, defaultSourceId, federatedSources] = await Promise.all([
    isGlobalBasenameEnabled(engine),
    loadActivePackForLocalEngine(engine),
    isCrossSourceLinksEnabled(engine),
    resolveLinkFallbackDefault(engine),
    loadAllSources(engine, { federatedOnly: true }),
  ]);
  const federatedSourceIds = new Set(federatedSources.map(source => source.id));
  // Match extract --stale semantics: deterministic fuzzy/exact resolution,
  // never the live put_page keyword fallback.
  const resolver = makeResolver(engine, { mode: 'batch', sourceId });
  const extractOptions = {
    skipFrontmatter: !includeFrontmatter,
    globalBasename,
    pack: pack?.manifest ?? null,
  };
  // First discover the candidate slugs, then fetch only the endpoint universe
  // needed by this page. This preserves qualified/cross-source resolution
  // without rebuilding an all-brain (slug, source) map for every durable page
  // request in a large managed sweep.
  const first = await extractPageLinks(slug, `${page.compiled_truth}\n${page.timeline}`,
    page.frontmatter, page.type, resolver, extractOptions);
  const endpointSlugs = [...new Set([slug, ...first.candidates.flatMap(c => [c.targetSlug, c.fromSlug ?? slug])])];
  const metadata = endpointSlugs.length ? await engine.executeRaw<LinkPageMetadata>(`SELECT slug, source_id, type, title,
    frontmatter->'aliases' AS aliases, knowledge_revision::text AS knowledge_revision
    FROM pages WHERE deleted_at IS NULL AND slug IN (SELECT unnest($1::text[])) ORDER BY source_id, slug`, [endpointSlugs]) : [];
  const allSlugs = new Set<string>(metadata.map(row => row.slug));
  const slugToSources = new Map<string, string[]>();
  for (const row of metadata) {
    const sources = slugToSources.get(row.slug) ?? [];
    sources.push(row.source_id);
    slugToSources.set(row.slug, sources);
  }
  // A new put_page origin is not yet visible at preparation time. Managed
  // stale requests normally already have this row, but retaining the source
  // identity here keeps this helper safe for coordinator callers that publish
  // the origin in the same outer transaction.
  allSlugs.add(slug);
  const originSources = slugToSources.get(slug) ?? [];
  if (!originSources.includes(sourceId)) originSources.push(sourceId);
  slugToSources.set(slug, originSources);
  const targetMetadata = new Map(metadata.map(p => [`${p.source_id}\0${p.slug}`, p]));
  const extracted = await extractPageLinks(slug, `${page.compiled_truth}\n${page.timeline}`,
    page.frontmatter, page.type, resolver, {
      ...extractOptions,
      targetType: (targetSlug, targetSourceId) => {
        const resolved = resolveCandidateSources({ targetSlug, targetSourceId, linkType: '', context: '' }, slug,
          sourceId, allSlugs, slugToSources, federatedSourceIds.has(sourceId), { crossSource, defaultSourceId });
        return resolved.ok ? targetMetadata.get(`${resolved.toSourceId}\0${targetSlug}`)?.type : undefined;
      },
    });
  const { candidates, unresolved } = extracted;

  const linkRows: LinkBatchInput[] = [];
  let skippedMissingTarget = 0;
  let skippedCrossSource = 0;
  for (const c of candidates) {
    const resolved = resolveCandidateSources(c, slug, sourceId, allSlugs, slugToSources,
      federatedSourceIds.has(sourceId), { crossSource, defaultSourceId });
    if (!resolved.ok) {
      if (resolved.reason === 'cross_source') skippedCrossSource++;
      else skippedMissingTarget++;
      continue;
    }
    linkRows.push({
      from_slug: resolved.fromSlug,
      to_slug: c.targetSlug,
      link_type: c.linkType,
      context: c.context,
      link_source: c.linkSource,
      origin_slug: c.originSlug,
      origin_field: c.originField,
      from_source_id: resolved.fromSourceId,
      to_source_id: resolved.toSourceId,
      origin_source_id: sourceId,
    });
  }

  const previous = [...await engine.getLinks(slug, { sourceId }), ...await engine.getBacklinks(slug, { sourceId })];
  const pageKeys = new Map<string, { sourceId: string; slug: string }>();
  pageKeys.set(`${sourceId}\0${slug}`, { sourceId, slug });
  for (const row of linkRows) for (const [sid, target] of [
    [row.from_source_id ?? sourceId, row.from_slug], [row.to_source_id ?? sourceId, row.to_slug],
  ] as Array<[string, string]>) pageKeys.set(`${sid}\0${target}`, { sourceId: sid, slug: target });
  for (const link of previous) for (const [sid, target] of [
    [link.from_source_id, link.from_slug], [link.to_source_id, link.to_slug],
  ] as Array<[string, string]>) pageKeys.set(`${sid}\0${target}`, { sourceId: sid, slug: target });

  return {
    pageKeys: [...pageKeys.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.slug.localeCompare(b.slug)),
    apply: async (tx: BrainEngine) => {
      const origin = await tx.readPageSnapshot(slug, { sourceId });
      if (!origin) throw new Error('The automatic-link origin changed or was deleted.');
      // replaceDerivedLinks validates every exact (source_id, slug) endpoint
      // under the publication transaction; unlike the legacy auto-link path,
      // no broad existence probe is needed here.
      const reconciled = await tx.replaceDerivedLinks({
        slug, sourceId, expectedRevision: origin.revision, sourceIncarnation: origin.sourceIncarnation,
      }, linkRows, {
        includeFrontmatter,
        expectedEndpoints: capturedLinkEndpoints(linkRows, targetMetadata, { slug, sourceId }),
      });
      return { ...reconciled, errors: 0, unresolved_count: unresolved.length,
        skipped_missing_target: skippedMissingTarget, skipped_cross_source: skippedCrossSource };
    },
  };
}
