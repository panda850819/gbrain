import { ALL_PAGE_TYPES } from './types.ts';

export type OrphanTier = 'knowledge' | 'flow';

const FLOW_TYPE_HINTS = ['atom', 'session', 'media', 'extract_receipt', 'report'] as const;

/**
 * Flow pages are operational/event artifacts. Prefer the canonical PageType
 * list when a flow type is already registered there, then keep the deployed
 * schema-pack names as fallbacks for brains that already persist them.
 */
export const FLOW_PAGE_TYPES: ReadonlySet<string> = new Set([
  ...ALL_PAGE_TYPES.filter(type => (FLOW_TYPE_HINTS as readonly string[]).includes(type)),
  ...FLOW_TYPE_HINTS,
]);

export function classifyOrphanTier(type: string | null | undefined): OrphanTier {
  return type && FLOW_PAGE_TYPES.has(type) ? 'flow' : 'knowledge';
}

export function orphanTierLabel(tier: OrphanTier): string {
  return tier === 'flow' ? 'Flow orphans (informational)' : 'Knowledge orphans (scored)';
}

export function flowPageTypeSqlList(): string {
  return [...FLOW_PAGE_TYPES].map(type => `'${type.replaceAll("'", "''")}'`).join(', ');
}
