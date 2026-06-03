# Brain Health Remediation Priority Order (Panda)

When `gbrain doctor --json` reports multiple failing checks, always repair in this strict order (highest impact on health score first):

1. **resolver_health** — Add missing `triggers:` arrays to skill frontmatter + add trigger rows in AGENTS.md under "Brain operations resolver" section. Re-run doctor immediately after; this check is cheap and blocks cronjob scoring.
2. **embedding_width_consistency** — Compare schema `vector(N)` vs gateway `embedding_dimensions`. If mismatch, follow the destructive migration recipe in the check output (ALTER TABLE + re-init + embed --stale). Never ignore — it silently degrades search quality.
3. **sync_failures** — Use `gbrain sync --skip-failed` only after confirming the failures are SLUG_MISMATCH on X originals. Fix frontmatter slug format before re-syncing; do not accumulate >2000 unacked failures.
4. **embeddings coverage + ze_embedding_health** — Run `gbrain embed --stale` only after dimension consistency is resolved. Set ZEROENTROPY_API_KEY if using that provider.

This order was derived from weekly cronjob health drops (resolver fail + embed mismatch causing 40/100 scores). Always verify with `gbrain doctor --json | grep -E 'resolver_health|embedding_width|sync_failures'` after each fix.

Linked from maintain/SKILL.md "Brain Health Remediation Priority Order" subsection.