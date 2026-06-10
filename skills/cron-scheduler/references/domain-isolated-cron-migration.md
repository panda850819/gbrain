# Domain-isolated cron migration

Use when a cron job was created in Panda's local Hermes but operationally belongs to another bot, host, profile, or workspace.

## Trigger

- User says a domain-specific cron should appear in a different bot/chat, or run on a VPS instead of Panda's laptop.
- Alerts from work/Yei infrastructure appear in the local PangPang Telegram home chat.

## Safe migration pattern

1. List local jobs and identify the exact job ID. Do not guess.
2. Pause the local job first, especially after a noisy failure.
3. Inspect the owning runtime:
   - SSH/host/container location.
   - `HERMES_HOME` and cron storage path.
   - `channel_directory.json` for the target chat/topic ID.
   - `hermes cron status` to confirm the scheduler is actually firing.
4. Copy or recreate the script under the remote Hermes scripts directory.
5. Run the remote script manually once. For watchdogs, expected healthy output should be empty.
6. Create the remote cron with explicit delivery target. Prefer `telegram:<chat_id>:<thread_id>` for topic-bound bots.
7. Convert timezone explicitly. If the remote runtime uses UTC and Panda asked for Taiwan morning, `09:00 Asia/Taipei` is `0 1 * * *` UTC.
8. Re-list both sides:
   - Local job is paused or removed.
   - Remote job is active with the desired next run.

## Watchdog wrapper rules

- `no_agent=True` jobs deliver any non-empty stdout, and non-zero/timeout errors are forced alerts.
- Suppress normal success and skip strings.
- Keep freshness operations best-effort if credential state is not yet configured, so missing auth does not spam the user.
- For private repos, do not enable push/PR/agentic jobs until GitHub auth or deploy keys are verified inside the same container/profile that will run the cron.

## Verification checklist

- Local `hermes cron list`: old job paused/removed.
- Remote `hermes cron list`: new job active.
- Remote `hermes cron status`: gateway/scheduler running.
- Delivery target is the intended bot/topic, not bare local home chat.
- Manual script run returns empty output when healthy.
