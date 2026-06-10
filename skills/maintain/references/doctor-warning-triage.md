# Doctor warning triage notes

Use this when explaining why a Brain health report shows warnings after an otherwise clean write.

## Key distinctions

- A clean page ingest can still surface pre-existing Brain maintenance debt. Say explicitly whether the newly written page validated and queried successfully before discussing global doctor warnings.
- `gbrain health` is a quick score; `gbrain doctor --json` is the detailed gate. They can disagree.
- `cycle_freshness` can fail even when `gbrain autopilot --status` says installed or shows recent cycle logs. The check is about whether the source has completed a full `gbrain dream` cycle record, not merely whether autopilot is installed or some sub-phases ran.
- `content_sanity_audit_recent` warnings are not the same as frontmatter or sync failure. If blocking/hard/quarantine/reject counts are zero, frame it as quality-review noise or flagged events, not broken Brain structure. When the audit entries are historical and already judged safe, preserve them with an `.ack-<timestamp>` suffix rather than deleting the JSONL.
- `flagged_pages` should be inspected with `gbrain quarantine list --include-flagged --json`. A `markup_heavy` page is still searchable; it just warns agents on retrieval. Durable fix pattern: move the full bulk mirror/table-heavy body to a `.raw/` sidecar, keep a concise retrieval-friendly index page at the original slug, and leave explicit links to the sidecar and backup path.
- `embed_staleness` with a tiny stale chunk count is usually a small post-edit backlog. Use `gbrain embed --stale --dry-run` to size it before proposing refresh. On Panda's macOS shell, manual Hermes terminal commands may need Keychain injection without printing the secret: `OPENAI_API_KEY="$(security find-generic-password -a panda -s OPENAI_API_KEY -w 2>/dev/null)" gbrain embed --stale`.
- `queue_health` is dynamic. A waiting queue warning can appear on a later doctor run even if absent earlier. Treat it as runtime backlog and inspect job/queue state before blaming a recent write.
- `subagent_capability` about prompt caching is a cost/runtime-posture warning, not a Brain content failure. Do not switch providers just to silence it unless the required provider key is available and the user accepts the model change.
- `takes_count` may be optional feature posture, especially when `takes.bootstrap_enabled` is unset or disabled. If `gbrain takes extract --from-pages --yes` returns `0 claim(s)` after scanning pages, report it as extraction yield/product posture rather than rerunning blindly.
- High orphan counts must be interpreted by type. Generated leaf types, notes, atoms, feed staging, reflections, and sidecar pages can inflate orphan ratios. After `gbrain extract all --source db` and `gbrain extract links --by-mention --source db`, bucket orphans by path prefix before deciding whether to add index pages, adjust doctor denominator/type filters, or leave them alone. Do not promise to fix all orphans without type-filtering.

## Suggested explanation shape

1. State whether the new page/write is clean: frontmatter, capture/get/query/link verification.
2. Say the global doctor warnings are pre-existing or system-level unless evidence ties them to the new write.
3. Group issues by severity:
   - P0: actual fail such as `cycle_freshness`.
   - P1: runtime backlog or concrete flagged pages.
   - P2: small maintenance backlog, stale embeddings, orphan triage.
   - P3: cost/config/optional features.
4. For each warning, give the likely cause and the next diagnostic command, not just the label.
