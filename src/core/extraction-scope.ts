/**
 * Page kinds that are generated machine artifacts rather than canonical
 * knowledge pages. They do not participate in link/timeline extraction
 * freshness accounting: atom graph state is installed by its producer and
 * extraction receipts are deliberately self-loop protected.
 */
export const EXTRACTION_EXCLUDED_PAGE_TYPES = ['atom', 'extract_receipt'] as const;

export function extractionPageTypePredicate(alias = ''): string {
  const prefix = alias ? `${alias}.` : '';
  return `${prefix}type NOT IN ('atom','extract_receipt')`;
}

export function extractionLivePagePredicate(alias = ''): string {
  const prefix = alias ? `${alias}.` : '';
  return `${prefix}deleted_at IS NULL AND ${extractionPageTypePredicate(alias)}`;
}
