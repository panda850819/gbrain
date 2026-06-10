# L1 Local Report Loops

Use this reference when a scheduled workflow should start as a low-risk loop before any auto-fix, external delivery, or production mutation.

## Pattern

```text
script-only cron -> local report -> STATE.md -> loop-run-log.md -> human review before action
```

Defaults:

- `deliver: local`
- `no_agent: true`
- `script:` is a script path/name only, usually under `~/.hermes/scripts/`
- no Telegram delivery on normal success
- no production config mutation
- no auto-fix, migrations, re-embed, file moves, or publishing
- generated report path is written to state for later inspection

## Minimal artifacts

Each loop should have:

```text
LOOP.md              # purpose, non-goals, cadence, verification, escalation, kill switch
STATE.md             # last_run, mode, latest input/output, last_report
loop-run-log.md      # append-only run history
~/.hermes/scripts/<loop-name>.sh
```

Store these inside the target workspace when the loop belongs to one workspace. For cross-system audits, use a dedicated local state root such as `~/.hermes/loop-state/<loop-name>/`.

## Cron shape

```text
cronjob create
  name: <Class L1 Report>
  schedule: <off-hours cron>
  deliver: local
  script: <script-name-only, no args>
  no_agent: true
```

The `script` field must not include arguments. If arguments are needed, create a wrapper script.

## Verification checklist

Before reporting success:

1. Run the script manually.
2. Verify exit code 0.
3. Read back `STATE.md` or the generated report path.
4. Confirm the cron job exists with `deliver: local`, `no_agent: true`, and the expected script name.

`cronjob(action='run')` queues the job for the next scheduler tick. If `last_status` has not updated immediately, do not imply the cron tick already completed. Use the manual script run and state/report readback as verification.

## Panda examples

- PangPang behavior eval L1: score the latest privacy-reviewed candidate output in `/Users/panda/.hermes/hermes-agent/.hermes/evals/pangpang/`; never patch production behavior from the loop itself.
- Brain Health L1 audit: read-only `gbrain doctor --fast`, `gbrain health`, `gbrain orphans --count`, `gbrain check-resolvable --json`, and read-only `gbrain lint`; never run `--fix`, migrations, re-embed, or file moves from L1.

## Promotion rule

Only promote to L2 assisted fixes after stable L1 reports and explicit Panda approval for the action class. Brain repairs should route through `brain-health-repair`; PangPang behavior patches should route through the local eval harness and `panda-ai-infra` rules.
