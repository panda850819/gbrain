#!/bin/bash
# Periodic auto-distill workhorse for ALL sources (Claude/Codex/Hermes).
# Distills pending sessions whose source jsonl has been QUIET for >= SETTLE_MIN
# minutes (a settled jsonl = the session has ended — no per-CLI session-end
# event needed; works for Codex's per-turn Stop and Hermes's compiled binary
# alike). Claude Code is also auto-distilled instantly by its SessionEnd hook;
# this cron is its backstop. Cheap headless model, capped, lock-guarded.
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
PY=/usr/bin/python3
SK="$HOME/gbrain/skills/transcript-ingest"
STAGE="$HOME/site/knowledge/brain/.raw/transcript-ingest"
LOG="$HOME/.gbrain/transcript-ingest-auto.log"
LOCK="/tmp/transcript-ingest-drain.lock"
# Prefer the self-contained native binary. The homebrew node cli.js (first on
# the PATH this script exports) is stale and node-dependent, so it lags the
# current version and breaks when node/node_modules shift — that killed this
# cron intermittently. Native first, PATH claude next, cmux last.
CLAUDE="$HOME/.local/bin/claude"
[ -x "$CLAUDE" ] || CLAUDE="$(command -v claude 2>/dev/null)"
[ -x "$CLAUDE" ] || CLAUDE="/Applications/cmux.app/Contents/Resources/bin/claude"
MODEL="claude-haiku-4-5-20251001"
SETTLE_MIN="${TI_SETTLE_MIN:-10}"
CAP="${TI_DRAIN_CAP:-25}"
ts() { date '+%Y-%m-%d %H:%M:%S'; }

[ -x "$CLAUDE" ] || exit 0
# Single-run lock (drain can be slow; never overlap).
if [ -f "$LOCK" ]; then exit 0; fi
trap 'rm -f "$LOCK"' EXIT
touch "$LOCK"

"$PY" "$SK/lib/collect.py" >/dev/null 2>&1

# Pending keys whose source jsonl is settled (mtime older than SETTLE_MIN), capped.
keys=$("$PY" - "$STAGE" "$SETTLE_MIN" "$CAP" "$SK/lib" <<'PYEOF'
import json, os, sys, time
stage, settle_min, cap, libdir = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
sys.path.insert(0, libdir)
from state_io import load_state
state = load_state(os.path.join(stage, "state.json"))
now = time.time()
rows = []
for k, v in state.items():
    if v.get("status") != "queued":
        continue
    p = v.get("path", "")
    try:
        age = now - os.path.getmtime(p)
    except OSError:
        age = 1e9  # source gone -> treat as settled
    if age < settle_min * 60:
        continue  # still active, let it settle
    rows.append((v.get("user_turns", 0) * 2000 + v.get("human_chars", 0), k))
rows.sort(reverse=True)
for _, k in rows[:cap]:
    print(k)
PYEOF
)

[ -z "$keys" ] && { echo "$(ts) drain: nothing settled" >>"$LOG"; exit 0; }

n=0
while IFS= read -r key; do
    [ -z "$key" ] && continue
    qfile="$STAGE/_queue/$key.txt"
    [ -f "$qfile" ] || continue
    prompt="You are a transcript distill worker. Read $SK/prompts/distill_prompt.md and execute it with: SESSION_FILE=$qfile | GATE_PROMPT=$SK/prompts/gate_prompt.md | DISTILLED_DIR=$STAGE/_distilled | KEY=$key. Output ONLY the final one-line report."
    report=$("$CLAUDE" -p "$prompt" --model "$MODEL" --permission-mode bypassPermissions </dev/null 2>>"$LOG" | tail -1)
    echo "$(ts) [drain] $report" >>"$LOG"
    if echo "$report" | grep -q "|"; then
        echo "$report" | "$PY" "$SK/lib/mark.py" >>"$LOG" 2>&1
        n=$((n+1))
    else
        echo "$(ts) [drain] no valid report for $key" >>"$LOG"
    fi
done <<< "$keys"

"$PY" "$SK/lib/file_distilled.py" >>"$LOG" 2>&1
echo "$(ts) drain: processed $n settled session(s)" >>"$LOG"
