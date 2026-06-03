# Weekly cron maintenance CLI pitfalls

Session-derived notes for running `maintain` from Hermes cron / no-MCP contexts.

## gbrain CLI drift seen on 0.40.x

- `gbrain find_orphans` is not available. Use `gbrain orphans --json` for the full list, or `gbrain orphans --count` when the JSON output is too large or parsing fails.
- `gbrain put <slug> < file.md` may fail on newer CLI versions. Prefer `gbrain put <slug> --content "$(<file.md)"` or a quoted equivalent from the calling language.
- Some slug paths are normalized lowercase in DB operations. For weekly reports, `gbrain put reflections/weekly/2026-w22 --content ...` may work while `2026-W22` fails. If the user requires an exact filesystem path such as `reflections/weekly/2026-W22.md`, do both: write/put the normalized DB slug, then write the exact requested filesystem path.
- `gbrain put` can fail when frontmatter `tags: [...]` triggers tag reconciliation before the page exists. If that happens, retry the DB write without `tags`, then keep the filesystem copy with tags if the repo convention requires them.

## Back-link repair loop

`gbrain check-backlinks fix` can create second-order missing back-links because newly edited entity pages mention other entities. Do not stop after one fix pass. Loop:

```bash
gbrain check-backlinks check /path/to/brain
# if missing links are reported:
gbrain check-backlinks fix /path/to/brain
gbrain sync --repo /path/to/brain
gbrain extract links --source db
# repeat check until: No missing back-links found.
```

Report both the first-pass and final totals if they differ.

## Report write order in cron

When MCP is unavailable, preserve both DB and filesystem state:

1. Generate the report content.
2. `gbrain put <normalized-slug> --content "$content"` to update DB.
3. Write the exact requested `*.md` path on disk, because autocommit/extract jobs read the filesystem.
4. Verify with `gbrain get <normalized-slug>` and `read_file`/filesystem stat for the exact path.

Do not treat a failed `put` as fatal if the filesystem report is written and subsequent `sync` succeeds, but record the failure in the report if DB verification still fails.