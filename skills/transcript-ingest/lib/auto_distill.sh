#!/bin/bash
# Background worker: gate+distill ONE just-ended session via a cheap headless
# model, mark state, file into the brain. Invoked detached by the SessionEnd
# hook so it never blocks session teardown. This is the auto /done.
set -u
PY=/usr/bin/python3
SK="$HOME/gbrain/skills/transcript-ingest"
STAGE="$HOME/site/knowledge/brain/.raw/transcript-ingest"
LOG="$HOME/.gbrain/transcript-ingest-auto.log"
CLAUDE="/Applications/cmux.app/Contents/Resources/bin/claude"
[ -x "$CLAUDE" ] || CLAUDE="$(command -v claude 2>/dev/null)"
MODEL="claude-haiku-4-5-20251001"
ts() { date '+%Y-%m-%d %H:%M:%S'; }

transcript="${1:-}"
[ -z "$transcript" ] && exit 0
[ -x "$CLAUDE" ] || { echo "$(ts) no claude binary" >>"$LOG"; exit 0; }
key="claude__$(basename "$transcript" .jsonl)"
qfile="$STAGE/_queue/$key.txt"

# Enqueue (idempotent: normalizes + sha-dedups + thin-filters this + any new).
"$PY" "$SK/lib/collect.py" >/dev/null 2>&1
[ -f "$qfile" ] || { echo "$(ts) skip $key (thin/dup/empty)" >>"$LOG"; exit 0; }

prompt="You are a transcript distill worker. Read $SK/prompts/distill_prompt.md and execute it with: SESSION_FILE=$qfile | GATE_PROMPT=$SK/prompts/gate_prompt.md | DISTILLED_DIR=$STAGE/_distilled | KEY=$key. Output ONLY the final one-line report."

report=$("$CLAUDE" -p "$prompt" --model "$MODEL" --permission-mode bypassPermissions 2>>"$LOG" | tail -1)
echo "$(ts) $report" >>"$LOG"
[ -n "$report" ] && echo "$report" | "$PY" "$SK/lib/mark.py" >>"$LOG" 2>&1
# File the result: personal SIGNAL -> brain/sessions; industry/yei/dup -> inbox.
"$PY" "$SK/lib/file_distilled.py" >>"$LOG" 2>&1
