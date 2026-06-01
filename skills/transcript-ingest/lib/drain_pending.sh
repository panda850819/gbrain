#!/bin/bash
# Periodic auto-distill workhorse for ALL sources (Claude/Codex/Hermes).
# Distills pending sessions whose source jsonl has been QUIET for >= SETTLE_MIN
# minutes (a settled jsonl = the session has ended — no per-CLI session-end
# event needed; works for Codex's per-turn Stop and Hermes's compiled binary
# alike). Claude Code is also auto-distilled instantly by its SessionEnd hook;
# this cron is its backstop. Cheap headless model, capped, lock-guarded.
set -u
PY=/usr/bin/python3
SK="$HOME/gbrain/skills/transcript-ingest"
STAGE="$HOME/site/knowledge/brain/.raw/transcript-ingest"
LOG="$HOME/.gbrain/transcript-ingest-auto.log"
LOCK="/tmp/transcript-ingest-drain.lock"
CLAUDE="/Applications/cmux.app/Contents/Resources/bin/claude"
[ -x "$CLAUDE" ] || CLAUDE="$(command -v claude 2>/dev/null)"
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
keys=$("$PY" - "$STAGE" "$SETTLE_MIN" "$CAP" <<'PYEOF'
import json, os, sys, time
stage, settle_min, cap = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
state = json.load(open(os.path.join(stage, "state.json")))
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
    report=$("$CLAUDE" -p "$prompt" --model "$MODEL" --permission-mode bypassPermissions 2>>"$LOG" | tail -1)
    echo "$(ts) [drain] $report" >>"$LOG"
    [ -n "$report" ] && echo "$report" | "$PY" "$SK/lib/mark.py" >>"$LOG" 2>&1
    n=$((n+1))
done <<< "$keys"

"$PY" "$SK/lib/file_distilled.py" >>"$LOG" 2>&1
echo "$(ts) drain: processed $n settled session(s)" >>"$LOG"
