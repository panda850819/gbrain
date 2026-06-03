# Transcript-ingest leading HTML comment fix

Use this when `gbrain frontmatter validate` reports `MISSING_OPEN` on transcript-ingest/session pages, but line 2 starts valid YAML frontmatter.

## Problem shape

Some transcript-ingest pages were written as:

```md
<!-- transcript-ingest: domain=industry, needs entity-level filing -->
---
title: ...
date: 2026-05-28
type: session
...
---
```

`gbrain frontmatter` requires the first non-empty line to be `---`, so the leading HTML marker triggers `MISSING_OPEN` even though the YAML block itself is valid.

## Safe repair

1. Make a backup before mutation, e.g. `<file>.manual-fmfix-YYYY-MM-DD.bak`.
2. Remove the leading HTML comment.
3. Preserve its semantic information as frontmatter fields:
   - `generated_by: transcript-ingest`
   - `source_kind: agent-transcript`
   - `filing_note: 'needs entity-level filing'` when the marker says `needs entity-level filing`
   - `possible_dup_of: <slug>` when the marker says `possible-dup-of=<slug>`
4. Add `created` and `updated` if missing. Prefer the existing `date:` value, then date from filename/path.
5. Re-run structural validation and schema overlay scan.
6. Update the daily frontmatter report if this was triggered from a cron digest.

## Example before/after

Before:

```yaml
<!-- transcript-ingest: domain=industry, needs entity-level filing -->
---
title: Stock-theme research KOL roster
date: 2026-05-28
type: session
domain: industry
source_key: claude__...
tags: [stock-kols]
---
```

After:

```yaml
---
title: Stock-theme research KOL roster
date: 2026-05-28
created: 2026-05-28
updated: 2026-05-28
type: session
domain: industry
source_key: claude__...
generated_by: transcript-ingest
source_kind: agent-transcript
filing_note: 'needs entity-level filing'
tags: [stock-kols]
---
```

## Verification

Run both:

```bash
gbrain frontmatter validate /Users/panda/site/knowledge/brain --json
```

And a schema overlay that excludes hidden/worktree dirs and `.bak` files. Expected result after repair: zero structural errors and zero schema overlay issues.
