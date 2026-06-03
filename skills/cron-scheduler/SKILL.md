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

## Idempotency Requirement

Every cron job MUST be idempotent:
- Running the same job twice produces the same result (no duplicate pages, no duplicate timeline entries)
- Use checkpoint state files to track progress and resume interrupted runs
- Check for existing output before creating new output

## Output Format

Job configuration saved. Report: "Job '{name}' scheduled at {cron expression}. Next run: {time}."

## Delivery verification for Telegram channels

When Panda asks a cron job to deliver to a `t.me/<channel>` URL, do not leave the job on `telegram:@username`. Hermes delivery expects numeric Telegram chat IDs and may fail with `invalid literal for int() with base 10`. Resolve the channel username to its numeric chat ID, update the cron `deliver` target to `telegram:<numeric_id>`, then send a real test message before claiming success. If the test fails with `Forbidden: bot is not a member of the channel chat`, tell Panda to add the active bot as a channel member/admin with posting permission, keep the numeric target in the job, and re-test after the permission change. See `references/telegram-channel-cron-delivery.md` for the detailed operator checklist.

## Human-facing cron copy quality

When a Panda-facing cron job needs to publish to a Telegram channel where Hermes' own bot lacks permission, use the n8n/project-bot fallback in `references/telegram-channel-n8n-bot-delivery.md`: set the cron `deliver` to `local`, keep data collection in `script`, and have the cron agent send via Telegram Bot API with the project bot token without printing secrets. This is the preferred pattern for channels like `@pdzeng_talk` that are administered by `@n8n_panda_bot` rather than the Hermes gateway bot.

When a cron job emits a short DM, optimize for immediate usefulness, not cleverness. If the job surfaces a reflective question, it must be concrete enough for Panda to answer in 2-3 sentences:
- Name the object under reflection, e.g. company, thesis, project, decision, or page.
- Give 2-3 discriminating options instead of abstract labels.
- Include one observable criterion that separates the options.
- Avoid vague abstractions like "conviction / control point / narrative" unless tied to a named object.

Good: `強茂要用 SiC/車規 ramp、AI PSU 訂單能見度，還是技術面 breakout 當保留條件？`
Bad: `留下的是 conviction、控制點，還是熟悉敘事？`

## Migrating script/no-agent jobs back to Hermes agent

When a Panda-facing cron job previously ran through a script that spawned an external agent (`claude -p`, Claude Code, Codex, OpenCode), migrate it into a Hermes cron agent instead of raising the external agent's turn limit:

1. Inspect the active job first (`hermes cron list` or the cron tool) and preserve schedule, delivery target, workdir, skills, and toolsets.
2. Update the job with `script` cleared and `no_agent=false`; attach the class-level skills the job should follow, and restrict toolsets to the minimum needed, usually `terminal,file` for local brain maintenance.
3. Put the prohibition directly in the cron prompt when the failure mode matters: "do not call Claude Code/Codex/OpenCode; do not execute `claude` or `claude -p`; use Hermes tools + local CLI only." Avoid vague wording like "avoid external agents" by itself.
4. Retire the old script after verifying it is no longer referenced. Prefer moving it to `~/.Trash/<name>.retired-<timestamp>` over deleting it permanently.
5. Verify by reading the active job record: `script is null`, `no_agent is false`, expected `skills`, expected `enabled_toolsets`, expected `workdir`, and the prompt contains the explicit external-agent prohibitions.
6. Ignore historical backup/state-snapshot matches unless they are active scheduler inputs; they are recovery records, not live dependencies.

## Anti-Patterns

- Scheduling jobs at the same minute (:00 for everything)
- Inline 3000-word prompts in cron jobs (use skill file references)
- Running cron jobs without testing on 3-5 items first
- Jobs that produce different output on re-run (not idempotent)
- Sending notifications during quiet hours (save to held queue instead)
- Using Claude Code, Codex, or local crontab as long-term schedulers for Panda-facing workflows that notify Telegram, write brain pages, or need agent judgment. Use Hermes cron for those; reserve launchd for long-lived services and Claude Code/Codex for one-shot worker tasks. See `references/cron-approval-continuation.md` for the continuation pattern when a scheduled job sends an approval message and Panda replies `ok`.
- Trying to publish to Telegram channels through Hermes' gateway bot when the channel is actually administered by a different project/n8n bot. Use `deliver: local` plus the project bot API fallback in `references/telegram-channel-n8n-bot-delivery.md` instead of repeatedly changing numeric chat IDs.
