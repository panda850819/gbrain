---
name: cron-scheduler
version: 1.0.0
description: |
  Schedule management with staggering, quiet hours, and wake-up override.
  Validates schedules, prevents collisions, and gates delivery during quiet hours.
triggers:
  - "schedule a job"
  - "cron"
  - "quiet hours"
  - "what jobs are running"
tools:
  - search
  - get_page
  - put_page
mutating: true
---

# Cron Scheduler

> **Convention:** See `skills/conventions/test-before-bulk.md` — test every cron job on 3-5 items first.

## Contract

This skill guarantees:
- Schedule staggering: max 1 job per 5-minute slot, no collisions
- Quiet hours gating: timezone-aware, with user-awake override
- Thin job prompts: jobs say "Read skills/X/SKILL.md and run it" (no inline 3000-word prompts)
- Idempotency: jobs can run twice without duplicate side effects
- Results saved as reports: `reports/{job-name}/{YYYY-MM-DD-HHMM}.md`

## Phases

1. **Define job.** Name, schedule (cron expression), skill to run, timeout.
2. **Validate schedule.** Check no collision with existing jobs (5-minute offset rule).
   - Slots: :05, :10, :15, :20, :25, :30, :35, :40, :45, :50
   - If collision detected, suggest the next available slot
3. **Check quiet hours.** Default: 11 PM - 8 AM local time.
   - Override: user-awake flag (if user is active, quiet hours suspended)
   - During quiet hours: save output to held queue
   - Morning contact releases the backlog
4. **Register with host scheduler.** OpenClaw cron, Railway cron, crontab, or process manager. **Each registered entry should execute via Minions, not `agentTurn`.** See `skills/conventions/cron-via-minions.md` for the rewrite pattern (PGLite uses `--follow`, Postgres uses fire-and-forget + `--idempotency-key` on the cycle slot). GBrain's v0.11.0 migration auto-rewrites entries for built-in handlers; host-specific handlers need a code-level registration per `docs/guides/plugin-handlers.md`.
5. **Write thin prompt.** Job prompt is one line: "Read skills/{name}/SKILL.md and run it."

## Updating existing jobs from prompts to inference

When Panda rejects a reminder-style cron that asks him to fill in data, do not create a second job unless the schedule truly changes. Update the existing job in place:
- List jobs, identify the current job ID, then `cronjob(action='update', job_id=...)`.
- If the old job is `no_agent: true` with a tiny script that prints a question, clear `script` with `script: ""`, set `no_agent: false`, and give the job a self-contained prompt that infers the answer from available sessions, brain notes, and cron outputs.
- Keep the same delivery target and schedule unless Panda asked to change timing.
- Restrict toolsets to what the inference needs, e.g. `session_search`, `file`, `terminal` for an EOD summary.
- Verify with `cronjob(action='list')` that `script` is gone, `no_agent` is false, and the next run is still scheduled.

## Idempotency Requirement

Every cron job MUST be idempotent:
- Running the same job twice produces the same result (no duplicate pages, no duplicate timeline entries)
- Use checkpoint state files to track progress and resume interrupted runs
- Check for existing output before creating new output

## Output Format

Job configuration saved. Report: "Job '{name}' scheduled at {cron expression}. Next run: {time}."

## Multi-source brains: use `sync --all`, not per-source entries

When the brain has 2+ active sources (anything `gbrain sources list` shows
with a non-null `local_path` that isn't archived), use one consolidated
cron line instead of N per-source entries.

**Preferred (multi-source)**:

```cron
*/5 * * * * gbrain sync --all --parallel 4 --workers 4 --skip-failed
```

This replaces N per-source lines AND auto-picks-up future sources without
a crontab edit. Concurrency budget: `parallel × workers × 2 ≈ 32`
connections during the wave (each per-file worker opens its own
2-connection pool). Stay under your Postgres `max_connections` setting.

**Avoid (legacy)**: separate `gbrain sync --source default` and
`gbrain sync --source zion-brain` entries staggered by 5 minutes. They
require manual deconfliction every time a new source is added, and a
slow source can race a fast source on the legacy global `gbrain-sync`
lock (v0.40.3.0+ uses per-source `gbrain-sync:<sourceId>` locks but the
per-source cron pattern doesn't benefit from the parallelism that
`--all --parallel` actually delivers).

`gbrain doctor` surfaces the recommended line as a `sync_consolidation`
check whenever it detects 2+ active sources. Paste-ready from there.

## PangPang / Hermes cron noise audits

When Panda asks to reduce Telegram noise or clean PangPang/Hermes cron, start with a read-only delivery-policy audit before changing schedules or deleting jobs. Classify every job as `Alert`, `Digest`, `Local only`, or `Retire candidate`; then convert maintenance/ingest success paths to `deliver: local` or true silent-on-success. For `no_agent=True`, any non-empty stdout is delivered verbatim, so wrappers must suppress normal skip/success strings, including `[SILENT]`. See `references/pangpang-cron-noise-audit.md` for the full checklist.

## Domain-isolated cron ownership

When a cron belongs to a separate operating domain, keep both execution and delivery inside that domain instead of letting Panda's local Hermes become the accidental scheduler:

- Yei Brain cron belongs on the Linode VPS / Yei Hermes runtime, not Panda's local Hermes default profile.
- First pause the local job to stop duplicate or misrouted alerts, then recreate or enable the job on the owning host/profile.
- On the remote runtime, verify `HERMES_HOME`, `channel_directory.json`, `hermes cron status`, and the delivery target. Prefer explicit topic targets such as `telegram:<chat_id>:<thread_id>` over bare `telegram:<chat_id>`.
- Convert local-time schedules carefully when the remote scheduler runs UTC, e.g. Taiwan 09:00 = `0 1 * * *` UTC.
- For `no_agent` watchdogs, make remote freshness steps best-effort and non-spamming; emit stdout only for actionable alerts or watchdog failure.
- If the job needs write access, push, PR creation, or private repo freshness, verify container-level GitHub auth/deploy keys before enabling agentic jobs.
- See `references/domain-isolated-cron-migration.md` for the migration checklist and watchdog wrapper pattern.

## Anti-Patterns

- Scheduling jobs at the same minute (:00 for everything)
- Inline 3000-word prompts in cron jobs (use skill file references)
- Running cron jobs without testing on 3-5 items first
- Jobs that produce different output on re-run (not idempotent)
- Sending notifications during quiet hours (save to held queue instead)
- Separate per-source `gbrain sync --source <id>` cron entries when
  `gbrain sync --all --parallel N --workers N` would replace them with
  one line that auto-picks-up future sources.
- Using Claude Code, Codex, or local crontab as long-term schedulers for Panda-facing workflows that notify Telegram, write brain pages, or need agent judgment. Use Hermes cron for those; reserve launchd for long-lived services and Claude Code/Codex for one-shot worker tasks. See `references/cron-approval-continuation.md` for the continuation pattern when a scheduled job sends an approval message and Panda replies `ok`.

## L1 local report loops

When converting a repeated AI-infra workflow into a Loop Engineering pattern, start with an L1 local report loop before any auto-fix or Telegram delivery:

- `deliver: local`
- `no_agent: true`
- `script:` is a wrapper script name only, no arguments
- manual script run + state/report readback before claiming success
- promote to assisted fixes only after stable reports and explicit Panda approval

See `references/l1-local-report-loops.md` for the full checklist and Panda examples.
