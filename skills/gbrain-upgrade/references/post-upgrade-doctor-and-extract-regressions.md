# Post-upgrade doctor / extract regression notes

Use this reference when a local gbrain fork is ahead of upstream and post-upgrade validation finds `doctor` warnings or `extract --stale` crashes. This is session-derived detail, not a blanket rule for all installs.

## Safe sequence

1. Do not blindly self-upgrade a local fork with ahead commits. Check branch, remotes, and local diff first.
2. Reproduce the failing command with a bounded fixture or dry run before editing production paths.
3. Add a regression test that fails before the fix.
4. Patch the root cause.
5. Run targeted tests first, then broader typecheck / doctor / stale extraction validation.
6. Only after validation, decide whether to commit or proceed to schema-pack migrations.

## Array literal crash pattern

Symptom:

- `gbrain extract --stale` fails with a Postgres `malformed array literal` error.
- Trigger pages may include link contexts with braces, quotes, wiki-link aliases, or unusual Unicode.

Likely cause:

- Manually interpolated arrays in SQL such as `unnest(...::text[])` can serialize as Postgres array literals and break on special characters.

Durable fix pattern:

- Bind arrays as parameters, not literal strings.
- For `postgres-js`, use the correct array OID for `text[]`, usually `sql.array(values, 1009)`.
- Add a test that covers braces, quotes, wiki-link aliases, and Unicode edge cases.

## Unpaired surrogate pattern

Symptom:

- Postgres text insert/update fails when context windows slice an emoji or non-BMP character in half.

Fix pattern:

- Sanitize strings before database writes by removing unpaired UTF-16 surrogates.
- Keep valid surrogate pairs intact.
- Add a regression test with a dangling high or low surrogate.

## Stale extraction watermark pattern

Symptom:

- `gbrain extract --stale` keeps reporting the same rows as stale even after a successful extraction.

Likely cause:

- JavaScript `Date.toISOString()` truncates Postgres microseconds. A stored extraction watermark can remain slightly behind `updated_at` or `version_ts`.

Fix pattern:

- Compute the extraction watermark from `max(updated_at, version_ts)` and add a small safety margin, such as `+1ms`, before storing.
- Add a regression test with a microsecond timestamp greater than the JS millisecond boundary.

## Doctor warnings vs failures

When a doctor check reports content-sanity audit events, separate blocking events from non-blocking warnings:

- Blocking: `hard_block`, `quarantine`, `reject`, `soft_block`.
- Non-blocking: `flag`, `warn`.

A large number of non-blocking large-page or quality warnings should not become a red FAIL that hides real blockers. Report them as WARN and preserve counts.

## Validation checklist

- Targeted regression tests pass.
- `tsc --noEmit` passes.
- `gbrain extract --stale --dry-run` reports zero stale pages after a successful extraction.
- `gbrain doctor` reports no FAIL checks. WARN-only is acceptable when remaining items are product choices, backlog drains, provider strategy, or schema migrations.
