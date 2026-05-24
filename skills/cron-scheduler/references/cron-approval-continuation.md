# Cron approval continuation reference

Use when a scheduled job sends an approval-needed message and Panda replies `ok`.

## Real case

- Job: Brain Dream
- job_id: `32a43fa9462f`
- Stored output: `~/.hermes/cron/output/32a43fa9462f/2026-05-12_09-21-57.md`
- Telegram quote was truncated after the first pending artifact, so the stored output was the authoritative plan.

## Continuation steps that worked

1. List/identify cron jobs only if the `job_id` is not enough.
2. Read the latest output file for that `job_id`.
3. Extract pending artifacts from the stored output.
4. Verify current brain state before writing, because auto-commit or prior agents may already have changed files.
5. Write the approved artifacts.
6. Add backlinks from source/session/entity pages.
7. Verify files exist and are non-empty.
8. Report exact created/updated paths.

## Pitfall

Do not answer only "已收到" after Panda replies `ok`. In this context, `ok` is an approval signal for the pending cron plan.
