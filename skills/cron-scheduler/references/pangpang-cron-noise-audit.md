# PangPang cron noise audit pattern

Use when Panda asks to reduce Telegram noise, clean Hermes cron, or simplify PangPang runtime without changing the architecture.

## Core learning

For PangPang cleanup, the cron problem is usually not raw job count. The first thing to inspect is delivery policy:

- `Alert`: interrupt only on anomaly or threshold crossing.
- `Digest`: intentionally user-facing summary, concise and scheduled.
- `Local only`: maintenance, ingest, enrichment, ledger, and repair jobs that should not send success/skip messages.
- `Retire candidate`: mark first; do not delete in the first pass.

## Read-only audit fields

```text
Job:
Job ID:
Schedule:
Current delivery:
Script / skills:
no_agent:
Current status:
Category: Alert / Digest / Local only / Retire candidate
Noise risk: Low / Medium / High
Keep reason:
Change proposal:
Verification:
```

## Delivery policy defaults

- Keep Telegram delivery for true digests: daily brief, EOD reflection, X/Trend triage digest, weekly brain-health, market heartbeat when it is designed as a user-facing summary.
- Keep Telegram delivery for true alerts: watchdogs, threshold-based market/security alerts.
- Convert maintenance success paths to `local` or silent-on-success: frontmatter guards, source ledgers, health ingest/enrichment, collectors, EOD/brain ingest scripts.
- For `no_agent=True`, any non-empty stdout is delivered verbatim. A string like `[SILENT]` is still non-empty unless the wrapper suppresses it.
- Scripts that print normal skip/success messages are not silent-on-success. Patch the wrapper or change delivery to `local`.

## Collision checks

- Look for jobs sharing the exact same minute, especially quiet-hours maintenance clusters.
- High-frequency alert jobs such as `*/10 * * * *` collide with many `:00` jobs. Audit whether the alert posts directly outside Hermes before changing Hermes delivery.
- Avoid exact `:00` for non-human-facing jobs where possible. Prefer staggered slots like `:05`, `:15`, `:25`, `:35`, `:45`.

## Safe first batch

1. Change local ingest/maintenance jobs to `deliver: local`.
2. Patch wrappers to suppress normal skip/success stdout if they remain Telegram-delivered.
3. Preserve alert jobs and digest jobs until their thresholds/verbosity are separately audited.
4. Verify with `cronjob list`, then run low-risk jobs manually only when safe.

## Pitfalls

- Do not delete or archive cron jobs in the first cleanup pass.
- Do not silence watchdogs that are meant to alert on real failures.
- Do not assume `last_status: ok` means no Telegram noise. It only means the job completed.
- Do not assume `deliver: origin` is safe for collector/maintenance jobs. If stdout is non-empty, it can still notify Panda.
