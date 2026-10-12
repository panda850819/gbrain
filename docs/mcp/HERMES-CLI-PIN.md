# Hermes CLI pin — observed behavior notes (v0.21.6)

Dev-facing companion to [HERMES.md](HERMES.md): every fact below was OBSERVED
against a real install (re-observed 2026-10-12 against the v0.21.6 pin), not
researched from docs. The claw-test HermesRunner, the install door e2e, and the
heavy-tests hermes-door CI job assert exactly these shapes — when hermes
releases change them, update this file, the workflow pins, and the affected
assertions together.

## Pin
- **Hermes Agent v0.21.6 (2026.9.24)** — release tag `v0.21.6` = commit
  `818c13be1dc4fd28987e1e881a9408224afd4535` (on upstream `main`), installed at
  `~/.hermes/hermes-agent`. Upstream moved release tags from CalVer
  (`v2026.8.3`) to semver (`v0.21.6`); the CalVer date survives as the
  parenthesized release date in `--version`.
- Installer sha256: `034845e34289813ff5fb7fd3e071ec69f6b14aee8ba297a477b31dda6374cb86`
  (re-pinned 2026-10-12; byte-identical to upstream `scripts/install.sh` at
  `dcabf7631`, 1,049 lines). Download https://hermes-agent.nousresearch.com/install.sh
  to a file first; verify; then run.
- Installer flags used: `--skip-setup --non-interactive --skip-browser
  --skip-computer-use --branch main --commit <sha>`; the launcher lands at
  `~/.local/bin/hermes` (a two-line `sh` wrapper that execs
  `~/.hermes/hermes-agent/.hermes/bin/hermes`).
- Runtime: PM-managed Python 3.14.7, Node 26.7.0, uv 0.12.3, all under
  `~/.hermes/tools/`.

### Installer review record (2026-10-12: `2076946e…` → `034845e3…`)
The prior pin (upstream `0610291b`, 3,678 lines) drifted by 79 upstream commits
to `scripts/install.sh`. This is a REWRITE, not an incremental change: the
installer became a thin bootstrap (clone → pinned uv → bootstrap Python) that
hands everything else to code inside the cloned checkout —
`python -m pm.cli install` (the new in-repo package manager) and
`hermes_cli/source_completion.py` (command publication + product builds, the
same tail `hermes update` runs). Full new script reviewed line by line; the
diff against the old pin was reviewed by section.

- **Door flags: all intact.** `--branch`/`--commit`/`--skip-browser`/
  `--skip-computer-use`/`--skip-setup`/`--non-interactive` still parse;
  `--skip-setup` is now an alias for `--non-interactive`. The skip flags became
  PM's persisted opt-outs (`pm install --without agent-browser --without
  cua-driver`); observed: no browser or cua-driver artifacts land in
  `~/.hermes/tools/`. Unknown flags still hard-fail (`exit 1`); a value flag
  with a missing or dash-leading value fails with `exit 2`. Removed flags
  (unused by the door): `--no-venv`, `--no-skills`, `--force-commit`, `--ensure`.
- **Layout: unchanged for the door.** `INSTALL_DIR` defaults to
  `$HERMES_HOME/hermes-agent` = `~/.hermes/hermes-agent`; the root-only FHS
  layout (`/usr/local/lib/hermes-agent`) is gone.
- **BREAKING for the old pin — the payload pin had to move.** (1) The new
  installer reads `pm/lock.json` and runs `pm.cli` + `source_completion.py`
  from the checkout; none exist at the old payload `v2026.8.3`/`3c27eb62`
  (PM landed 2026-08-29), so the old payload cannot be installed by the
  current installer. (2) A pinned fresh clone now verifies
  `git merge-base --is-ancestor <commit> origin/<branch>` before publishing; a
  tag passed as `--branch` has no `origin/<tag>` ref, so it hard-fails
  (observed: `commit … is not on branch v0.21.6`). CI therefore clones
  `--branch main --commit <release sha>` and additionally asserts
  `refs/tags/$HERMES_GIT_TAG^{commit}` == the pinned commit.
- **Network surface shrank.** Gone from the installer: astral's `curl | sh`
  uv bootstrap, direct nodejs.org / npmmirror / pypi fetches, the duckduckgo
  connectivity probe, the unpinned trycua computer-use pipe from
  raw.githubusercontent.com, and in-script distro `sudo` installs. The only
  download left in the script is uv 0.12.3 from github.com/astral-sh releases,
  sha256-verified against an inline generated pin table; a fallback to
  `hermes-assets.nousresearch.com` (NEW host) is taken only on curl
  network-class errors and is verified against the SAME digest. Every
  artifact PM then fetches (node, npm, ffmpeg, ripgrep, python) is
  sha256-pinned in `pm/lock.json` inside the commit-pinned checkout; Python
  deps install via `uv.lock` (hash-verified), JS deps via `npm ci`. No
  `eval`, no base64, no `curl | sh` anywhere in the script.
- **Flagged for awareness (not blocking):**
  - The installer digest now covers far less of the install logic — the real
    trust anchor is the payload commit pin (+ the new tag assertion). Keep
    re-pinning both together.
  - `HERMES_REPO_URL` / `HERMES_INSTALL_DIR` / `HERMES_RUNTIME_DIR` env
    overrides redirect the clone source / install dir / tool store. None are
    set in the door job; never set them there.
  - New local install receipt at
    `$HERMES_HOME/telemetry/shared_metrics/pending_installs/<id>.json`
    (closed tokens + two timestamps; the installer itself sends nothing).
    Hermes only reports it while `telemetry.shared_metrics.enabled` is on,
    and both `enabled` and `send` default to `false` at the pinned commit.
  - `sudo`: interactive runs may `sudo -v` up front for libatomic; under
    `--non-interactive` it only refreshes an existing ticket with `sudo -n -v`
    (never prompts). PM may `sudo -n` install libatomic on a glibc host that
    lacks it — GitHub's ubuntu runners ship it; not observed in the
    rehearsal.
- **Rehearsal:** the exact door command ran end-to-end under `env -i` (no
  secrets) with an isolated `HOME`: exit 0, checkout HEAD = tag = pinned
  commit, `hermes --version` → `Hermes Agent v0.21.6 (2026.9.24)`. The door
  suite then ran against it: `--version`, `mcp add` handshake + saved config
  + `mcp test`, and the direct-`config.yaml` test all pass; the paid SMOKE
  leg reached Anthropic (401 on a dummy key — needs the real secret).

## HERMES_HOME — HONORED (verified)
Installer (`HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"`) AND runtime both honor it:
`mcp add`/`mcp list`/`config set` under `HERMES_HOME=<tmp>` read+write `<tmp>/config.yaml`,
populate `<tmp>/{SOUL.md,cron,logs,...}`, and do NOT touch `~/.hermes`. Belt-and-suspenders
(HOME + HERMES_HOME both to tmp) stays in the door test anyway.

**Borrowed data root (v0.21.6).** Dependency state is per data root, so a fresh
`HERMES_HOME=<tmp>` "borrows" the installed checkout: most commands lazily
prepare `<tmp>`'s dependency environment on first run (stderr: `preparing
dependencies for this data root (the checkout's updates belong to …)`), but the
`--version` / `-h` fast path instead exits 1 with `no dependency environment is
committed for this install; run 'hermes pm repair'`. The door's version test
runs `hermes pm repair` (exit 0, a few seconds) in its fresh home first.

## One-shot (`-z`)
- `hermes -z "<prompt>"` → **stdout = final text ONLY**; benign notices may appear on stderr
  ("Shell cwd was reset to ..."). Verified reply fidelity ("B0-PROBE-OK").
- Exit codes: 0 = success; **1 = no inference provider configured** (message:
  "agent failed: Hermes is not connected to any AI provider yet. Run `hermes model` ...
  or add a key with `hermes auth add <provider>`."); **2 = provider rejected the key**
  (e.g. "Anthropic rejected your API key ... HTTP 401: invalid x-api-key").
- `--usage-file PATH` exists; per-call `-m MODEL --provider PROVIDER` exist; also
  `--in DIR`, `--ignore-user-config`, `--safe-mode`, `-t TOOLSETS`, `--skills`.

## Auth + model pin (non-interactive)
- `$HERMES_HOME/.env` with `ANTHROPIC_API_KEY=...` WORKS (verified end-to-end).
- Model pin: `hermes config set model.default anthropic/claude-haiku-4.5` → exit 0,
  writes `model.default` into config.yaml. `hermes config get model.default` reads it back.
  (`hermes model` is INTERACTIVE-only — never use it in tests/CI.)
- Valid model id format: `anthropic/claude-haiku-4.5` (hermes catalog naming, provider-prefixed).

## `hermes mcp add` — THE big observed facts
- Shape: `hermes mcp add <name> [--env K=V K2=V2 ...] [--connect-timeout N] --command CMD --args ...`
  **`--args` MUST be the last option** — anything after it (incl. a misplaced `--env`) is
  swallowed into the server argv. (First rehearsal failed exactly this way.)
  **The env flag takes MULTIPLE KEY=VALUE values after ONE flag; REPEATING it REPLACES the
  first occurrence** (argparse nargs semantics) — a repeated-flag invocation silently drops
  the earlier vars, the handshake fails, and the piped Y then hits the save-anyway prompt →
  the entry is saved with `enabled: false`. (First real door run failed exactly this way.)
- Add performs a REAL MCP handshake + tool discovery at add time. Against
  `--command bun --args run <abs>/src/cli.ts serve` with `--env GBRAIN_HOME=<tmp>`:
  connected, discovered **110 gbrain tools**.
- On success it prompts `Enable all N tools? [Y/n/select]:` — **non-interactive: pipe
  `printf 'Y\n'`**. Piping Y saves: `✓ Saved 'gbrain' to <HERMES_HOME>/config.yaml (110/110
  tools enabled)`. EOF on the prompt = `Cancelled.`, nothing saved.
- **EXIT CODE IS 0 EVEN ON CONNECTION FAILURE OR CANCEL.** Never assert on `mcp add`'s exit
  code. Hard assertions = (a) `config.yaml` contains `mcp_servers.<name>` after the add,
  (b) `hermes mcp test <name>` exits 0.

## Saved config schema (verbatim shape)
```yaml
_config_version: 50
mcp_servers:
  gbrain:
    command: bun
    args:
      - run
      - /abs/path/src/cli.ts
      - serve
    env:
      GBRAIN_HOME: /tmp/gb-xxxx
    connect_timeout: 60.0
    enabled: true
```
(The generated file also contains commented template blocks — security, fallback_model.)

## Probes
- `hermes mcp list` → table `Name / Transport / Tools / Status`, row shows `gbrain ... ✓ enabled`.
- `hermes mcp test gbrain` → exit 0 + prints the tool list. THE targeted probe for Test 1b.
- `hermes doctor` exists (global health; not a per-server assertion).

## Cron (for the post-pin F7 TODO — real test is buildable)
`hermes cron create [--name NAME] [--deliver ...] [--repeat N] [--skill S] [--script PATH]
[--no-agent] [--workdir DIR] [--model M] [--provider P] <schedule> [prompt]` — fully
non-interactive. `hermes cron tick` = run due jobs once and exit. `hermes cron list` exists.

## CI pin values (heavy-tests.yml `hermes-door` job)
- `HERMES_VERSION: "0.21.6"`
- `HERMES_GIT_BRANCH: "main"` + `HERMES_GIT_TAG: "v0.21.6"` +
  `HERMES_GIT_COMMIT: "818c13be1dc4fd28987e1e881a9408224afd4535"` —
  the installer's `--branch`/`--commit` flags pin the cloned PAYLOAD (the sha256 below only
  pins the installer script; without the commit the payload would be upstream main).
  `--branch` is `main`, not the tag, because the installer requires the commit to be an
  ancestor of `origin/<branch>`. The pins are asserted, not trusted: post-install the job
  checks `git -C ~/.hermes/hermes-agent rev-parse HEAD` == the commit AND
  `refs/tags/$HERMES_GIT_TAG^{commit}` == the commit, loud-failing on any mismatch, so an
  installer that silently ignores flags (or a moved checkout layout, or a moved tag) can
  never run unpinned upstream code on a runner that later holds secrets.
- `HERMES_INSTALL_SHA256: "034845e34289813ff5fb7fd3e071ec69f6b14aee8ba297a477b31dda6374cb86"`
- Door test asserts `hermes --version` output contains `v$HERMES_VERSION` when the env var is set.
- `hermes --version` output shape: `Hermes Agent v0.21.6 (2026.9.24) · upstream <sha>` + install
  dir, install method, Python, OpenAI SDK lines (+ an `Update available` line when main has moved).
- Missing-secret posture is SPLIT by trigger: on `pull_request` the paid leg is
  a VISIBLE SKIP (warning + job summary; installer digest, payload, and version
  pins still verified — neither a fork nor a branch PR author can fix repo
  secrets, and a permanently-red door trains reviewers to ignore it). The
  nightly schedule and `workflow_dispatch` stay loud-fail so the owner sees red
  until `gh secret set ANTHROPIC_API_KEY` runs.

## Multi-provider 401 gotcha (door hermeticity)
With `model.default` pinned to `anthropic/*` but a SECOND provider key visible (env or
.env — e.g. `OPENAI_API_KEY`), hermes's provider-auto mis-routes the request and the turn
returns `HTTP 401: Missing Authentication header` as final text with EXIT 0. The door
suite therefore seeds exactly ONE key (anthropic) and scrubs all provider env vars from
hermes children (`hermesChildEnv` in test/helpers/agent-harness.ts) — the seeded
`$HERMES_HOME/.env` is the single auth source.

## mcp add save-anyway (correction to an earlier note)
A piped `Y` saves the entry EVEN when the handshake failed — the save-anyway prompt
writes it with `enabled: false`. The success discriminators are `enabled: true` in the
saved YAML plus `hermes mcp test <name>` exit 0 — never the add's exit code, and not the
mere presence of the config entry.
