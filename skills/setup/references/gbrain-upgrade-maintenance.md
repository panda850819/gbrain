# GBrain Upgrade Maintenance Notes

Use this reference when the user asks to re-read a GBrain repo, upgrade an existing install, or diagnose post-upgrade health.

## Upgrade from a fork or linked checkout

1. Inspect the installed CLI source before upgrading:
   ```bash
   which gbrain
   gbrain --version
   cd ~/gbrain && git remote -v && git status -sb
   git branch --show-current
   ```
2. If the local checkout is tracking a stale fork, preserve the current state first:
   ```bash
   git branch backup/pre-upgrade-$(date +%Y%m%d-%H%M%S)
   git fetch upstream
   git checkout master
   git reset --hard upstream/master
   bun install
   gbrain --version
   ```
3. Never delete untracked skill/reference directories during an upgrade unless the user explicitly confirms they are disposable.

## Post-upgrade validation

Run the newer health checks and fix root causes before reporting success:

```bash
gbrain doctor
gbrain models doctor || true
gbrain providers list || true
gbrain features || true
gbrain smoke-test || true
```

If `gbrain smoke-test` fails only because it cannot see the DB env while `gbrain doctor` succeeds via config, rerun with the configured DB URL exported for that command. Do not print secrets.

## Long-running services must be drained before migration

Before running the first command on a new gbrain version that touches the DB schema, stop any long-running services that use the OLD code in memory: launchd `com.gbrain.autopilot`, `com.pdzeng.gbrain-http`, `com.pbrain.autocommit`, and any standalone `gbrain serve` / `gbrain jobs work` processes.

A schema migration races against in-memory old-code workers holding row locks; the migration blocks indefinitely while autopilot keeps writing under stale assumptions. The clean upgrade order is:

1. `launchctl unload` every gbrain launch agent.
2. `pkill -f "bun.*gbrain"` (verify nothing remaining with `pgrep -fl "bun.*gbrain"`).
3. Run any non-mutating command (`gbrain stats` or `gbrain doctor`) to let migration finish.
4. `launchctl load` the launch agents back; verify HTTP, autopilot, autocommit each spin up on the new version.

## Environment propagation on macOS

Interactive shells may load credentials from `~/.zshrc` while launchd jobs and non-interactive shells do not. Check without exposing the key:

```bash
printenv OPENAI_API_KEY >/dev/null && echo env-ok || echo env-missing
launchctl getenv OPENAI_API_KEY >/dev/null && echo launchctl-ok || echo launchctl-missing
zsh -ic 'gbrain providers list'
```

For launchd-managed GBrain services, prefer wrapper scripts that source the user's shell profile before starting `gbrain autopilot`, `gbrain serve --http`, or workers.

## Process hygiene after restart/upgrade

After restarting launch agents, inspect for duplicate stale stdio servers:

```bash
pgrep -af 'gbrain (serve|autopilot|jobs work)'
lsof -nP -iTCP:<port> -sTCP:LISTEN
```

Expected for an HTTP host may include autopilot, worker, and one HTTP `gbrain serve --http` process chain. Multiple old stdio `gbrain serve` processes are usually stale and can be terminated after confirming they are not attached to an active MCP client.

## CLI regression workaround pattern

When a post-upgrade command is routed to the wrong subcommand, inspect the CLI dispatch table before assuming user error. Example pattern seen once: `gbrain search modes` was swallowed by a generic `search <query>` operation until `search` was added back to the CLI-only command set.

Patch locally only when it is a small, obvious dispatch fix, then record the repo as ahead of upstream and include the commit in the user report.

## Integration recommendations

Treat `gbrain features` / integrations as suggestions, not automatic installs. Compare with the user's existing collectors first:

- If Google Workspace is already handled by `gog`, prefer `gog calendar/email -> brain` collectors over installing a duplicate OAuth recipe.
- If X/Twitter is already handled by `bird`, prefer `bird -> brain ingest` over native X API recipes.
- If a public HTTP MCP endpoint and tunnel already exist, do not blindly install a new ngrok recipe.
- Legacy OpenClaw-specific recipes are historical unless the user explicitly asks for OpenClaw work.

## Reporting

Report concise status by category: version, doctor score, schema version, embedding/provider state, daemon/process state, smoke-test result, remaining local patches, and any integration recommendations that were intentionally skipped.
