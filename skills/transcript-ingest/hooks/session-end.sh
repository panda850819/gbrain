#!/bin/bash
# Claude Code SessionEnd hook: auto-distill the ending session into the brain.
# Fast + non-blocking — parses the hook JSON for transcript_path and fires the
# background worker detached, then returns immediately so session teardown is
# never delayed. This replaces manual /done for Claude Code sessions.
input=$(cat)
transcript=$(printf '%s' "$input" | /usr/bin/python3 -c "import sys,json
try: print(json.load(sys.stdin).get('transcript_path',''))
except Exception: print('')" 2>/dev/null)
[ -z "$transcript" ] && exit 0
nohup "$HOME/gbrain/skills/transcript-ingest/lib/auto_distill.sh" "$transcript" >/dev/null 2>&1 &
exit 0
