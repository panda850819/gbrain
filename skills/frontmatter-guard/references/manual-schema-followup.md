# Manual schema follow-up after Daily Frontmatter Guard

Use this when a Daily Frontmatter Guard cron digest says `待人工` / `Remaining manual items` even though `gbrain frontmatter validate` is structurally clean.

## Problem shape

The cron report may combine two validator layers:

1. `gbrain frontmatter validate <brain>`
   - Structural YAML validity.
   - Catches parse errors, missing `---`, slug mismatch, null bytes, nested quotes.
2. Cron/schema overlay
   - Checks brain frontmatter convention from `RESOLVER.md`.
   - Common codes: `TYPE_INVALID`, `REQUIRED_MISSING`, `TYPE_FOLDER_MISMATCH`.

So a later command can report `ok=True total_errors=0` while the cron report still has manual schema items. Do not stop there.

## Workflow

1. Read the daily report at:
   - `brain/reflections/daily-frontmatter/YYYY-MM-DD.md`
2. Parse every item under `Unfix items`, not only the top 3 shown in Telegram.
3. For `TYPE_INVALID`, map to a RESOLVER-allowed class-level type:
   - `curation-prep` -> `note`
   - `observation` -> `note`
   - `checklist` -> `task`
   - `template` -> `note` plus move the workflow label to `generated_by: template` or `tags`
   - `report` -> `note` in Panda's current brain convention for `reports/*`, plus preserve the report/workflow role in `generated_by` or `tags`. Only keep `type: report` if the local schema has explicitly adopted it.
4. For `REQUIRED_MISSING`, infer conservative dates in this order:
   - `created` / `updated` already present
   - `date:` field
   - date in filename or path
   - `captured_at` / `ingested_at`
   - today only for README/index pages where no better date exists
5. Re-run both checks:
   - `gbrain frontmatter validate /Users/panda/site/knowledge/brain --json`
   - a schema overlay scan against RESOLVER allowed types and required `created` / `updated`, excluding `.claude/`, hidden dirs, and `.bak` files.
6. Update the same daily report with:
   - original manual count
   - manual follow-up count, should be 0
   - note that original `Unfix items` were fixed after Panda asked.

## Pitfalls

- `gbrain frontmatter audit --json` can return `per_source: []` in headless runs. Use direct path validation.
- `validate --json` output is huge. Pipe through a small parser and only print summary counts.
- The brain contains worktrees / hidden directories under `.claude/`; do not include those in schema backlog counts.
- Do not create a one-off skill for a daily report. Keep this as a reference under `frontmatter-guard`.
