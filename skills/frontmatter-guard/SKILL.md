---
name: frontmatter-guard
version: 1.2.0
description: |
  Validate and auto-repair YAML frontmatter on brain pages. Catches malformed
  pages before they enter the brain (missing closing ---, nested quotes, slug
  mismatches, null bytes, empty frontmatter, YAML parse failures). Wraps the
  `gbrain frontmatter` CLI for agent-driven workflows.
triggers:
  - "validate frontmatter"
  - "check frontmatter"
  - "fix frontmatter"
  - "frontmatter audit"
  - "brain lint"
  - "daily frontmatter"
tools:
  - exec
mutating: true
---

# Frontmatter Guard Skill

> **Convention:** see `skills/conventions/quality.md` for citation rules; this skill is structural validation, not citation auditing.

## Contract

This skill guarantees:
- Every brain page is scanned against the seven canonical frontmatter validation classes
- Mechanical errors (nested quotes, missing closing `---`, null bytes, slug mismatch) are auto-repairable on demand with `.bak` backups
- Validation logic is shared with `gbrain doctor`'s `frontmatter_integrity` subcheck — single source of truth
- Reports per source (gbrain is multi-source since v0.18.0); never silently audits the wrong root

## Why This Exists

Brain pages pile up over months. Agents write them with malformed frontmatter:
- Missing closing `---` (entity detector bugs)
- Unstructured YAML in meeting pages (ingestion bugs)
- Slug mismatches (path renames not propagated)
- Null bytes (binary corruption from copy-paste accidents)
- Nested double quotes in titles (`title: "Phil "Nick" Last"`)

Without a guard, these accumulate silently until `gbrain sync` chokes or search returns garbage. The guard makes the failure visible at audit time and trivially fixable.

## Validation classes

| Code | Meaning | Auto-fixable? |
|------|---------|---------------|
| `MISSING_OPEN` | File doesn't start with `---` | No (needs human) |
| `MISSING_CLOSE` | No closing `---` before first heading | Yes |
| `YAML_PARSE` | YAML failed to parse | Sometimes (depends on cause) |
| `SLUG_MISMATCH` | Frontmatter `slug:` differs from path-derived slug | Yes (removes the field) |
| `NULL_BYTES` | Binary corruption (`\x00`) | Yes |
| `NESTED_QUOTES` | `title: "outer "inner" outer"` shape | Yes |
| `EMPTY_FRONTMATTER` | Open + close present but nothing between | No (needs human) |

## Phases

### Phase 0.5: Cron manual backlog follow-up

When Panda replies to a Daily Frontmatter Guard digest with `Fix it`, inspect the full daily report, not just the Telegram top 3. The digest can include a second schema overlay beyond structural YAML validation, so `gbrain frontmatter validate <brain> --json` may be clean while `TYPE_INVALID` / `REQUIRED_MISSING` items remain in the report.

Use `references/manual-schema-followup.md` for the exact workflow: parse `reflections/daily-frontmatter/YYYY-MM-DD.md`, fix all listed manual items, run direct structural validation plus a schema overlay scan that excludes hidden/worktree dirs, then update the same report with the post-fix zero count.

### Phase 1: Audit

Run a read-only scan across all registered sources (or one with `--source <id>`).

```bash
gbrain frontmatter audit --json
```

Reports:
- Per-source counts grouped by error code
- Sample of up to 20 affected pages per source
- Total count
- Scan timestamp

Output is JSON; agents parse `errors_by_code` and `per_source` to decide next steps.

### Phase 2: Validate one path

Validate a single file or directory (does not require source registration):

```bash
gbrain frontmatter validate <path> --json
```

Exit code 0 = clean; 1 = errors found. Use this in CI pipelines or pre-commit hooks.

### Phase 2.5: File-direct validation (cron / headless fallback)

In cron runs, `gbrain frontmatter audit` may return an empty `per_source: []`
even when a source IS registered — if the source status is "never synced" or
if MCP is unavailable. **Do not trust a clean audit alone in headless context.**

Fallback: validate the brain directory directly. This does not depend on source
registration or sync status:

```bash
gbrain frontmatter validate /path/to/brain
gbrain frontmatter validate /path/to/brain --fix
gbrain frontmatter validate /path/to/brain --json
```

This scans all `.md` files under the path. The exit code and output are
identical to the source-based validate — just bypasses the source routing
layer entirely. Use this as the primary scan in cron jobs; reserve `audit`
for interactive sessions where you want per-source breakdowns.

When consuming `--json` for a large brain, do not let the full `results` array
flood the agent context. Pipe it through a compact reducer that keeps only
`total_files`, `total_errors`, `files_with_errors`, and entries whose `errors`
array is non-empty. Example:

```bash
gbrain frontmatter validate /path/to/brain --json | python3 -c '
import sys,json
j=json.load(sys.stdin)
print(json.dumps({
  "ok": j.get("ok"),
  "total_files": j.get("total_files"),
  "files_with_errors": j.get("files_with_errors"),
  "total_errors": j.get("total_errors"),
  "errors": [r for r in j.get("results", []) if r.get("errors")],
}, ensure_ascii=False, indent=2))'
```

If a cron task adds its own schema overlay beyond `gbrain frontmatter`, exclude
hidden/worktree/generated directories before mutating. At minimum skip `.git`,
`.obsidian`, `.trash`, `.claude`, `node_modules`, and any path component named
`worktrees`. These directories can contain historical or detached copies of the
brain; repairing them inflates counts and can create thousands of irrelevant
backups. If such a scope leak happens, restore affected hidden/worktree files
from the run's backups before writing the final digest.

### Phase 3: Fix

When issues are found:

```bash
gbrain frontmatter validate <path> --fix
```

`--fix` writes `<file>.bak` for every modified file before mutating. The backup is the safety contract — works whether the brain is a git repo or a plain directory.

`--dry-run` previews without writing. Use this before applying fixes in batch.

#### Known `--fix` coverage gap: YAML_PARSE

The auto-fixer handles `NESTED_QUOTES`, `MISSING_CLOSE`, `NULL_BYTES`, and
`SLUG_MISMATCH` reliably. However, **`YAML_PARSE` is only sometimes
auto-fixable** — and in practice `--fix` may report "Wrote centralized backups
for 0 file(s)" without fixing anything, even for simple-looking parse errors.

Known YAML_PARSE root causes that `--fix` does NOT handle (verified on
gbrain 0.33.x):
1. Unquoted `[[wikilinks]]` in YAML values — YAML interprets as flow sequences
2. Unquoted colons in `title:`, `description:`, `summary:` values
3. Unquoted `branch: -` — YAML interprets `-` as a sequence indicator
4. Unquoted `[[wikilink|alias]]` with pipe — YAML flow sequence collision
5. **`title:` starting with `@` (Twitter handle) or backtick `` ` ``** — YAML 1.1
   treats `@` as a reserved indicator; backtick triggers similar parse failure
   in js-yaml. Error message: `end of the stream or a document separator is
   expected at line N, column 8` pointing to the first character of the value.
   All 5 YAML_PARSE errors on 2026-05-29 were this pattern.

When `--fix` reports 0 fixes but issues remain, switch to **manual fix**
(see section below). Always check the output line `"Wrote centralized backups
for N file(s)"` — if N=0, nothing was repaired.

#### Manual YAML_PARSE fix

When `--fix` skips YAML_PARSE cases, the pattern is:

1. Read the file's first ~20 lines to understand the frontmatter
2. Identify the exact YAML construct causing the parse failure from the error message (column offset helps)
3. Single-quote the offending scalar value
4. Re-validate
5. Only fall back to `patch` if you understand the YAML structure; never blindly wrap `---` around content

Common patterns with exact fixes are documented in
`references/cron-yaml-parse-fix-patterns.md`.

#### Manual MISSING_OPEN fix for transcript-ingest pages

If `MISSING_OPEN` appears on transcript-ingest/session pages where line 1 is an HTML marker and line 2 is `---`, do not wrap the whole file or discard the marker. Move the marker's meaning into frontmatter, add missing `created` / `updated`, and revalidate.

Canonical mapping:
- `<!-- transcript-ingest: domain=... -->` → keep existing `domain:` if present
- `needs entity-level filing` → `filing_note: 'needs entity-level filing'`
- `possible-dup-of=<slug>` → `possible_dup_of: <slug>`
- add `generated_by: transcript-ingest`
- add `source_kind: agent-transcript`
- derive `created` / `updated` from existing `date:` first, then filename/path

Detailed example: `references/transcript-ingest-leading-comment-fix.md`.

### Phase 4: Pre-commit hook (optional)

For brain repos that ARE git repos, install the pre-commit hook to block malformed pages from being committed in the first place:

```bash
gbrain frontmatter install-hook [--source <id>]
```

The hook runs `gbrain frontmatter validate` against staged `.md`/`.mdx` files. Bypass with `git commit --no-verify`.

## Trigger words

When the user says any of these, route here:
- "validate frontmatter"
- "check frontmatter"
- "fix frontmatter"
- "frontmatter audit"
- "brain lint"

## Output rules

- Always run `gbrain frontmatter audit --json` first; never assume a brain is clean.
- Surface counts to the user in plain language; do not dump raw JSON.
- For `--fix` operations: state how many files will be modified BEFORE running, then confirm.
- `SLUG_MISMATCH` fixes remove the frontmatter `slug:` field — gbrain derives slug from path. Mention this when the user's title is intentionally renamed.
- Never auto-fix generic `MISSING_OPEN` or `EMPTY_FRONTMATTER` without explicit user input — these usually mean a human author started a page and didn't finish.
- Exception: auto-fix the safe transcript-ingest pattern where line 1 is `<!-- transcript-ingest: ... -->` and line 2 is `---`, by moving the marker into frontmatter per `references/transcript-ingest-leading-comment-fix.md`, adding `created` / `updated`, creating a dated backup, and revalidating.
- If a scheduled digest truncates `待人工` to the top 3 items, and Panda replies `Fix`, inspect the full report before acting. Fix the surfaced items immediately, but explicitly distinguish "surfaced items fixed" from "full backlog fixed" unless Panda asked for the entire backlog.
- Cron jobs: write daily report to `reflections/daily-frontmatter/YYYY-MM-DD.md` and create sentinel at `~/.local/state/hermes/daily-frontmatter-YYYY-MM-DD.md` for idempotency. If sentinel exists, still update the report but output `略過:今日已發送 YYYY-MM-DD` instead of a full digest.

## Chains with

- `gbrain doctor` — the `frontmatter_integrity` subcheck reports the same counts as `audit`.
- `skills/maintain/SKILL.md` — broader brain health audit; chain after this skill if other classes of issue are suspected.
- `skills/lint/SKILL.md` (via `gbrain lint`) — overlapping rules for skill-file lint; the `frontmatter-*` rule names in lint output come from this skill's validation surface.
- `references/cron-yaml-parse-fix-patterns.md` — manual fix patterns for YAML_PARSE cases that `--fix` cannot handle.

## Output Format

Audit summary (terse, agent-friendly):

```
Frontmatter audit — 17 issue(s) across 1 source(s)

[default] /Users/me/brain
  17 issue(s)
    MISSING_CLOSE: 8
    NESTED_QUOTES: 5
    NULL_BYTES: 4
  sample:
    people/jane.md — MISSING_CLOSE
    companies/acme.md — NESTED_QUOTES
    (+ 12 more)

Fix with: gbrain frontmatter validate /Users/me/brain --fix
```

JSON envelope (when `--json` is passed):

```json
{
  "ok": false,
  "total": 17,
  "errors_by_code": { "MISSING_CLOSE": 8, "NESTED_QUOTES": 5, "NULL_BYTES": 4 },
  "per_source": [
    {
      "source_id": "default",
      "source_path": "/Users/me/brain",
      "total": 17,
      "errors_by_code": { "MISSING_CLOSE": 8, "NESTED_QUOTES": 5, "NULL_BYTES": 4 },
      "sample": [{ "path": "people/jane.md", "codes": ["MISSING_CLOSE"] }]
    }
  ],
  "scanned_at": "2026-04-25T22:30:00.000Z"
}
```

`gbrain frontmatter validate <path> --json` returns a similar envelope keyed on per-file results instead of per-source.

## Prevention — Write-time guard for recurring agents/scripts

Daily repair is the fallback, not the design. If the same class of issue appears repeatedly, fix the writer.

Recommended pattern for any cron/script/AI that writes brain pages:
1. Use a canonical frontmatter template or helper, not free-form LLM-authored YAML.
2. Use allowed RESOLVER/schema types only. If the workflow-specific label is not a real brain type, store it in `generated_by`, `scope`, `source_kind`, or `tags`, not `type`.
   - Example: feed review prep should use `type: note` plus `generated_by: feed-review-prep`, not `type: curation-prep` unless the schema formally adds that type.
3. Always include `created` and `updated` for brain pages.
4. Serialize YAML or quote risky scalar values. Quote values containing `:`, `@`, backticks, `[[...]]`, `|`, brackets, or embedded quotes.
5. Immediately validate the file after write:

```bash
gbrain frontmatter validate <output-file>
```

If validation fails, fail the job or roll back instead of waiting for Daily Frontmatter Guard.

## Prevention — Writing Valid Frontmatter

**This is the most important section.** Fixing broken frontmatter is good. Not writing broken frontmatter in the first place is better.

### Write-time template gate for recurring scripts

When the same manual errors recur in daily cron reports, do not keep treating them as a cleanup task. Patch the writer.

Pattern:
1. Identify the generator from the affected files (`generated_by`, filename pattern, or source script).
2. Replace freehand YAML construction with a canonical template or serializer.
3. Add mandatory fields at write time: `type`, `created`, `updated`.
4. Validate the exact output file immediately after writing with `gbrain frontmatter validate <file>`.
5. For recurring artifacts that are workflow outputs rather than durable entity types, prefer an existing allowed type like `note` or `task` over inventing a new type.

Example pitfall from feed review prep: a cron-generated `type: curation-prep` repeated across many files. The right fix is to change the generator to emit an allowed type and validate the generated file, not to manually edit the same class of files after every run.

### YAML arrays (the historical #1 error source)

```yaml
# Correct: single-quoted YAML flow (canonical form gbrain emits)
tags: ['yc', 'w2025', 'ai']

# Correct: unquoted scalars (fine when values have no special chars)
tags: [yc, w2025, ai]

# Correct: block style
tags:
  - yc
  - w2025

# Tolerated post-v0.37.5.0 but non-canonical: JSON-style double quotes
tags: ["yc", "w2025"]

# Broken: mixed JSON objects and strings (invalid YAML)
tags: [{"name": "sports"}, "posterous"]
```

**Why this used to break:** before v0.37.5.0, the validator counted unescaped `"` characters and flagged any line with 3+. A flow sequence like `tags: ["yc", "w2025"]` has 4 unescaped `"` by design — it's valid YAML, but the dumb counter flagged it anyway. One brain saw 6,981 of these on a single doctor run. v0.37.5.0 parses suspicious values with `js-yaml.safeLoad` before flagging, so JSON-style arrays no longer trigger NESTED_QUOTES.

**Why you should still write the canonical form:** the auto-fix engine (`gbrain frontmatter validate --fix`) and the inferred-frontmatter serializer both emit single-quoted YAML for `tags:` / `aliases:`. Writing the canonical form in new content keeps the source files stylistically consistent and makes diffs against `--fix` runs empty.

**The classic LLM trap:** code like `tags: [${items.map(t => JSON.stringify(t)).join(', ')}]` produces `tags: ["yc", "w2025"]`. Use single quotes with an apostrophe fallback: `tags: [${items.map(t => t.includes("'") ? JSON.stringify(t) : "'" + t + "'").join(', ')}]`. Or use a YAML library that knows how to emit canonical YAML.

### Quoted scalars

```yaml
# Correct: single quotes for values with special chars
title: 'My "Quoted" Title'

# Correct: double quotes when value has apostrophes
title: "Men's Fashion Guide"

# Broken: double quotes wrapping inner double quotes
title: "My "Quoted" Title"
```

### When to quote at all

- **Unquoted** is fine for simple values: `type: person`, `batch: w2025`
- **Quote** when the value contains `: " ' # [ ] { } | > & * ! ? ,` or starts with `@`, `` ` ``, `*`, `&`, `!`, `%`, `#`
- **Single quotes** are the default safe choice
- **Double quotes** only when the value itself contains apostrophes

## Anti-Patterns

**Don't auto-fix generic `MISSING_OPEN` or `EMPTY_FRONTMATTER` without user input.** These usually mean a human author started a page and didn't finish — silently inserting `---` markers around an unfinished draft is wrong. The narrow exception is the safe transcript-ingest leading-comment pattern: line 1 HTML marker, line 2 `---`, valid frontmatter already present. Move the marker into frontmatter, add required dates, back up, and revalidate.

**Don't use `--fix` to "make doctor green" without reading the audit first.** SLUG_MISMATCH cases are surfaced for manual review specifically because gbrain derives the slug from path. A mismatch usually means the user renamed a file intentionally; auto-removing the slug field is the right outcome only when you've confirmed the rename was deliberate.

**Don't skip the `.bak` backups.** The `.bak` is the safety contract for non-git brain repos. If `.bak` files accumulate after a fix run, that's a feature, not a bug — the user can review the diffs and delete the backups when satisfied.

**Don't run `audit` on a brain where sources aren't registered.** The CLI returns "no registered sources to audit" gracefully, but the migration emits a `skipped: no_sources` phase result. Don't paper over this with a manual path-walk; the right fix is to register the source via `gbrain sources add`.

**Don't install the pre-commit hook on non-git brain dirs.** The install-hook command skips them automatically with a one-line note. If you see "skipped — not a git repo" and want validation at write time anyway, use the `audit` command on a cron schedule.

**Don't trust `audit` alone in headless/cron context.** A registered source with "never synced" status returns empty `per_source: []` with `ok: true`. This looks like a clean bill of health but the filesystem is unexamined. Always fall back to `gbrain frontmatter validate .` as the primary scan in cron jobs.

**Don't assume `--fix` handles all YAML_PARSE cases.** The auto-fixer cannot repair wikilinks in YAML scalars (`[[...]]`), unquoted colons in values, or `branch: -` as a standalone scalar. Check the "Wrote centralized backups for N file(s)" line — if N=0, nothing was repaired and manual fix is needed. See `references/cron-yaml-parse-fix-patterns.md`.
