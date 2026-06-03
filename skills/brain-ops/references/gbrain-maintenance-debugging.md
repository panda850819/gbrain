# GBrain Maintenance Debugging Notes

Use this when a brain health / maintenance pass surfaces tooling noise or extract failures. Keep the fix at the tool/rule layer when content is valid.

## Lint false positives

### `placeholder-date`

Symptom: `gbrain lint` reports hundreds of `placeholder-date` issues, mostly in `RESOLVER.md`, templates, README docs, or code examples.

Durable lesson:
- Do **not** edit valid route docs or templates just to satisfy lint.
- Narrow the lint rule to the actual risky surface: frontmatter date-like fields (`created`, `updated`, `date`, `published`, `ingested_at`, etc.).
- Ignore placeholder examples in body text and fenced code blocks.

Regression pattern:
- Keep a positive test for `created: YYYY-MM-DD` in frontmatter.
- Keep a negative test for body examples like ``sessions/YYYY-MM-DD-{slug}.md``.

### `code-fence-wrap`

Symptom: markdown pages with internal ```markdown fences near EOF are flagged as page-level wrapper artifacts.

Durable lesson:
- Flag only when the **entire page** is wrapped in ```markdown / ```md.
- Preserve internal fenced examples even when they close near EOF.

## Autopilot / Minions queue wedges

### Targeted-submit loop logs dispatches but creates no new jobs

Symptom:
- A watchdog reports `autopilot WEDGE`: autopilot log is fresh and repeatedly prints targeted dispatches, but `gbrain jobs list` shows the newest real job is old.
- The log may repeat the same historical job ids, e.g. `[dispatch] job #4448 sync (targeted: sync.repo; score=85)` and `[dispatch] job #4449 extract ...` every cycle.
- `launchctl kickstart -k gui/$(id -u)/com.gbrain.autopilot` alone can restart the process but does not fix the underlying wedge if the same old ids keep returning.

Root cause:
- Autopilot's periodic targeted path reused stable content-hash idempotency keys from `computeRecommendations()`.
- `MinionQueue.add()` correctly returns the existing row for a repeated `idempotency_key`, so after the first targeted job completed, later ticks "dispatched" the old completed row instead of inserting new work.
- Stable recommendation keys are good for deterministic `doctor --remediate` replays, but wrong for a recurring poller.

Preferred fix:
- Keep stable content-hash keys inside `computeRecommendations()`.
- In `src/commands/autopilot.ts`, scope the targeted-submit idempotency key to the current interval slot while preserving the step hash for debugging:

```ts
idempotency_key: `autopilot-targeted:${step.id}:${step.idempotency_key}:${slot}`,
```

Verification commands:

```bash
launchctl kickstart -k gui/$(id -u)/com.gbrain.autopilot
sleep 5
gbrain jobs list --limit 10
launchctl print gui/$(id -u)/com.gbrain.autopilot | grep -E 'state =|pid =|last exit code|runs ='
```

Expected:
- New job ids appear with current timestamps for the targeted handlers (`sync`, `extract`, `embed`, etc.).
- The LaunchAgent remains `state = running`.
- If `bun run typecheck` fails only on pre-existing missing dev/type deps, record that as verification caveat rather than attributing it to the autopilot patch.

## Postgres batch extract failures

### `malformed array literal` in `gbrain extract links --source db`

Symptom:
- `gbrain extract links --source db` reaches a batch and logs `batch error (... link rows lost): malformed array literal`.
- Error string contains fragments of large markdown contexts with quotes, commas, wikilinks, table pipes, or braces.

Root cause:
- Batch insert used `unnest($1::text[])` / text-array parameters for large markdown context columns.
- Complex markdown can be interpreted as a Postgres array literal and break the array-literal parser before insertion.

Preferred fix:
- For bounded batches, use parameterized `VALUES ($1, ...), ...` rows instead of `unnest($1::text[])` text arrays.
- Keep batch size conservative so placeholder count stays well below Postgres' parameter limit.
- Apply the same pattern to timeline batch writes if they pass free-form markdown summaries/details.

Verification commands:

```bash
gbrain extract links --source db 2>&1 | tee /tmp/gbrain-extract-links-check.log
! grep -q "batch error" /tmp/gbrain-extract-links-check.log

gbrain extract timeline --source db 2>&1 | tee /tmp/gbrain-extract-timeline-check.log
! grep -q "batch error" /tmp/gbrain-extract-timeline-check.log
```

## Stale pages triage

When `gbrain health` reports high stale pages, classify before editing.

Useful grouping:
- by path prefix (`people`, `companies`, `media`, etc.)
- by `type`
- by timeline count and latest timeline freshness

Durable lesson:
- High stale count dominated by `people/` and `companies/` is usually an entity synthesis queue, not a bulk rewrite queue.
- Start with high-signal, high-connectivity clusters, e.g. AI / agent infrastructure people and companies, then stock / finance entities.
- Do not bulk rewrite low-signal one-event entities just to reduce the metric.
