#!/usr/bin/env bash
# Sync gbrain skills to every runtime from the single source (~/gbrain/skills).
# Run this after adding/removing a gbrain skill.
#
#   Claude Code : per-skill symlinks in ~/.claude/skills/  (live; content auto-updates)
#   Codex       : lean plugin package + install into Codex plugin cache
#   Hermes      : nothing to do (config skills.external_dirs already live-scans ~/gbrain/skills)
#
# Single source of truth = ~/gbrain/skills. The Codex package (~/.gbrain-plugin) and
# its cache copy are BUILD ARTIFACTS — never edit them by hand.
set -euo pipefail

SRC="$HOME/gbrain/skills"
[ -d "$SRC" ] || { echo "ERROR: $SRC not found"; exit 1; }

# ─────────────────────────────────────────────────────────────────────────────
# 1) Claude Code — ensure a symlink exists for every gbrain skill (idempotent)
# ─────────────────────────────────────────────────────────────────────────────
CLAUDE_SKILLS="$HOME/.claude/skills"
linked=0
if [ -d "$CLAUDE_SKILLS" ]; then
  for d in "$SRC"/*/; do
    name=$(basename "$d")
    [ -f "$d/SKILL.md" ] || continue          # skip conventions/ migrations/ etc.
    target="$CLAUDE_SKILLS/$name"
    if [ ! -e "$target" ] && [ ! -L "$target" ]; then
      ln -s "${d%/}" "$target" && linked=$((linked+1))
    fi
  done
fi
echo "Claude Code: $linked new symlink(s) added (existing left as-is)"

# ─────────────────────────────────────────────────────────────────────────────
# 2) Codex — materialize lean plugin package + install into the plugin cache
# ─────────────────────────────────────────────────────────────────────────────
PKG="$HOME/.gbrain-plugin"
VERSION="0.42.13"
MKT="gbrain"; PLUGIN="gbrain"
CACHE_BASE="$HOME/.codex/plugins/cache/$MKT/$PLUGIN"

mkdir -p "$PKG/skills" "$PKG/.claude-plugin" "$PKG/.codex-plugin"
rsync -a --delete --exclude 'migrations/' "$SRC/" "$PKG/skills/"

cat > "$PKG/.claude-plugin/marketplace.json" <<JSON
{
  "\$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "$MKT",
  "description": "Panda's personal knowledge brain skills (hybrid RAG). Build artifact of ~/gbrain/skills.",
  "owner": { "name": "Panda Zeng" },
  "plugins": [
    { "name": "$PLUGIN", "description": "Personal knowledge brain skill pack. Skills auto-discovered under skills/.", "source": ".", "category": "knowledge" }
  ]
}
JSON

for mf in "$PKG/.claude-plugin/plugin.json" "$PKG/.codex-plugin/plugin.json"; do
cat > "$mf" <<JSON
{
  "name": "$PLUGIN",
  "version": "$VERSION",
  "description": "Personal knowledge brain (hybrid RAG) skill pack: ingest / query / enrich / data-query / maintain + brain-ops. Build artifact of ~/gbrain/skills.",
  "author": { "name": "Panda Zeng" },
  "keywords": ["brain","knowledge","rag","ingest","query","data-query","enrich"]
}
JSON
done

rm -rf "$CACHE_BASE"
mkdir -p "$CACHE_BASE/$VERSION"
rsync -a --delete "$PKG/" "$CACHE_BASE/$VERSION/"

N=$(find "$PKG/skills" -name SKILL.md | wc -l | tr -d ' ')
echo "Codex: built + installed $N skills -> $CACHE_BASE/$VERSION"
echo "       (config must have [marketplaces.$MKT] source=$PKG + [plugins.\"$PLUGIN@$MKT\"] enabled=true)"
echo "Hermes: no action (external_dirs live-scans $SRC)"
echo "Done."
