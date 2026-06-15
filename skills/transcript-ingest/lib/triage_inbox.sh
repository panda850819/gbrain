#!/bin/bash
# Surface the inbox/transcript-ingest backlog grouped by domain, so non-personal
# distills do not rot invisibly. Deliberately REPORT-ONLY, never auto-file:
# file_distilled.py routes industry/yei/dup here precisely because they need a
# human routing decision, and ~2/3 of the backlog is `domain: yei` WORK content
# that must NEVER be auto-written into the personal brain (it auto-commits +
# pushes to public GitHub within 15min — see feedback_no-work-content-in-personal-brain).
#
# Called by the daily reflection / retro to print a "## INBOX DRAIN" block.
# Usage: triage_inbox.sh            # human-readable report
#        triage_inbox.sh --count    # one-line summary for embedding in another report
set -u
INBOX="$HOME/site/knowledge/brain/inbox/transcript-ingest"
NOW=$(date +%s)

[ -d "$INBOX" ] || { echo "inbox/transcript-ingest: (none)"; exit 0; }

# Collect: domain<TAB>age_days<TAB>file
rows=$(
  for f in "$INBOX"/*.md; do
    [ -f "$f" ] || continue
    dom=$(grep -m1 -iE '^domain:' "$f" 2>/dev/null | sed 's/domain:[[:space:]]*//I' | tr -d '\r')
    [ -z "$dom" ] && dom="unknown"
    base=$(basename "$f")
    # Age from the session-date filename prefix; fmguard auto-repair resets mtime,
    # so mtime would falsely read 0d. Fall back to mtime only if no date prefix.
    fdate=$(printf '%s' "$base" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}')
    if [ -n "$fdate" ]; then
      fe=$(date -j -f "%Y-%m-%d" "$fdate" +%s 2>/dev/null || echo "$NOW")
    else
      fe=$(stat -f %m "$f" 2>/dev/null || echo "$NOW")
    fi
    age=$(( (NOW - fe) / 86400 ))
    printf '%s\t%s\t%s\n' "$dom" "$age" "$base"
  done
)
total=$(printf '%s\n' "$rows" | grep -c . )

if [ "$total" -eq 0 ]; then
  echo "inbox/transcript-ingest: empty ✓"
  exit 0
fi

# Per-domain destination guidance.
dest() {
  case "$1" in
    yei)      echo "→ Yei brain / work-vault ONLY. NEVER personal brain (leak guard).";;
    industry) echo "→ ~/site/knowledge/industry-db/ (industry brain).";;
    personal) echo "→ dup review: merge into existing brain/sessions/ or discard.";;
    *)        echo "→ inspect frontmatter, route per RESOLVER.md.";;
  esac
}

if [ "${1:-}" = "--count" ]; then
  summary=$(printf '%s\n' "$rows" | cut -f1 | sort | uniq -c | awk '{printf "%s=%s ", $2, $1}')
  oldest=$(printf '%s\n' "$rows" | sort -t$'\t' -k2 -rn | head -1 | cut -f2)
  echo "inbox/transcript-ingest: ${total} unfiled (${summary}) oldest ${oldest}d"
  exit 0
fi

echo "## INBOX DRAIN — inbox/transcript-ingest (${total} unfiled distills)"
echo ""
for dom in $(printf '%s\n' "$rows" | cut -f1 | sort -u); do
  n=$(printf '%s\n' "$rows" | awk -F'\t' -v d="$dom" '$1==d' | grep -c .)
  oldest=$(printf '%s\n' "$rows" | awk -F'\t' -v d="$dom" '$1==d' | sort -t$'\t' -k2 -rn | head -1 | cut -f2)
  echo "### ${dom} — ${n} file(s), oldest ${oldest}d  $(dest "$dom")"
  printf '%s\n' "$rows" | awk -F'\t' -v d="$dom" '$1==d {printf "  - %s (%sd)\n", $3, $2}' | sort
  echo ""
done
