# Brain Hygiene Pitfalls — Raw Feed Orphans + Batch Topic Staleness

Use this reference during brain maintenance when `gbrain health` is dragged down by huge orphan counts or stale topic/entity pages.

## Raw feed staging can poison orphan score

Symptom:
- `gbrain health` shows thousands of orphan pages.
- `gbrain orphans --json` or DB detail shows most are `type: inbox-feed` under `inbox/feed/YYYY-MM-DD/...`.
- `gbrain doctor` may still be healthy; this is content hygiene, not system health.

Root cause pattern:
- A feed staging cron/script writes raw feed items into the gbrain source tree, e.g. `brain/inbox/feed/{date}/...`.
- Even if frontmatter says `status: raw`, those files are imported as pages and counted as islanded/orphan if they have no inbound/outbound graph links.

Preferred fix:
1. Stop future writes into gbrain for raw feed staging.
2. Route raw feed files to a raw intake outside the gbrain source tree, e.g. Obsidian `Inbox/feeds/raw/{date}/...` or another non-gbrain raw store.
3. Keep only promoted, curated, or user-selected feed items in gbrain.
4. Update any review-prep scripts to read from the raw store while writing only the review brief / selected promotions back to brain.
5. For legacy `brain/inbox/feed/*`, do not delete blindly. Decide whether to move them to raw storage, archive them, or keep a temporary exclusion policy, then run full sync and verify orphan count.

Verification:
- `gbrain health` for orphan count trend.
- `gbrain orphans --count` and `gbrain orphans --json` for distribution.
- Check that new raw feed files are not appearing under the gbrain source path.
- If the migration deletes pages from gbrain DB directly, verify both filesystem and DB are clean: no `brain/inbox/feed` files and `SELECT count(*) FROM pages WHERE slug LIKE 'inbox/feed/%'` returns 0.

Implementation note from the 2026-05 feed cleanup:
- Future raw feed staging should target `~/site/knowledge/obsidian-vault/Inbox/feeds/raw/{date}/`.
- Update both writer and reader scripts together, e.g. `stage-feeds.ts` writes raw files there and `feed-review-prep.ts` reads from there.
- If a launchd/cron wrapper exists, update its comments and command path in the same change so the next maintenance pass does not infer the old `brain/inbox/feed` route.

## Batch topic/entity staleness after extraction

Symptom:
- `gbrain extract all --source db` creates many timeline entries.
- `gbrain health` stale pages jump, especially for topic/entity clusters.
- DB logic marks stale when `pages.updated_at < max(timeline_entries.created_at)` for that page.

For mechanical extraction-only staleness:
- If the page text is already current and extraction only materialized structured timeline rows, a mechanical refresh can be enough.
- Update the page's source file frontmatter `updated: YYYY-MM-DD`, then run a full/import sync so `pages.updated_at` is refreshed.

Safe batch pattern:
1. Identify stale cluster by slug prefix, e.g. `topics/stocks/%`.
2. Patch only frontmatter `updated:` on the matching source files.
3. Validate frontmatter for the directory.
4. Run `gbrain sync --repo <brain> --full --no-embed --yes` if incremental sync says "Already up to date" despite file mtime/frontmatter edits.
5. Run `gbrain extract all --source db`.
6. Run `gbrain embed --stale` if chunks changed.
7. Verify the target cluster stale count is zero.

Do not use this mechanical refresh when timeline entries contain new substantive evidence that compiled truth or the page body has not incorporated. In that case, read the page and rewrite the relevant summary/compiled truth with citations instead.

## Doctor vs health split

Explain clearly:
- `gbrain doctor` = system health, resolver/skills/schema/RLS/embeddings/sync failure state.
- `gbrain health` = content/graph quality, including orphans and stale pages.

A brain can have `doctor: healthy 100/100` and still have `health: 8/10` because raw or legacy content is not graph-connected or because topic pages need synthesis.
