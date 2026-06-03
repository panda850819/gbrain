# GBrain doctor vs health triage notes

Use this when `gbrain doctor` and `gbrain health` disagree, or when a weekly hygiene cron reports sync failures, resolver health, or large orphan/stale counts.

## Distinguish the two scores

- `gbrain doctor --json` is system/infrastructure health: resolver reachability, skill conformance, DB/schema/RLS/vector setup, sync failures, embeddings, graph coverage, integrity checks.
- `gbrain health` is content graph quality: embed coverage, missing embeddings, stale pages, orphan pages, entity link/timeline coverage.
- It is normal for `doctor` to be healthy while `health` is still 8/10 because raw inbox/feed pages are isolated or compiled-truth pages are stale.

## Sync failures triage

1. Inspect `doctor --json` `sync_failures` first.
2. If failures are `SLUG_MISMATCH`, run frontmatter audit/fix or validate the affected files. `SLUG_MISMATCH` means frontmatter `slug:` disagrees with path-derived slug. Preferred fix is usually removing the explicit `slug:` field so gbrain derives it from path.
3. Re-run `gbrain sync --retry-failed --json` or `gbrain sync --retry-failed`.
4. If retry succeeds but doctor still reports old unacknowledged failures, run `gbrain sync --skip-failed --yes` to acknowledge historical entries.
5. If embeddings were deferred or missing, run `zsh -lc 'source ~/.zshrc >/dev/null 2>&1; gbrain embed --stale'` so Panda's OpenAI key from shell init is available.

Do not treat `~/.gbrain/sync-failures.jsonl` as active failure by itself. It can contain acknowledged historical failures. Doctor's `sync_failures` check tells whether they are active.

## Resolver health in workspace skills

`gbrain doctor` may inspect the current workspace's `skills/` and resolver, not only the brain repo. In Telegram/cron sessions, check `PWD`, `TERMINAL_CWD`, or `MESSAGING_CWD` when resolver errors mention an unexpected tree such as `/Users/panda/clawd`.

The resolver parser expects markdown table rows with backtick-wrapped skill paths, for example:

```markdown
## Brain operations

| Trigger | Skill |
|---|---|
| browser automation, web scraping, headless browser, agent-browser | `skills/agent-browser/SKILL.md` |
```

Bullet rows like `- skills/foo/SKILL.md: trigger words` may be human-readable but can be invisible to `check-resolvable`.

If `skill_conformance` or orphan resolver triggers appear:

- Ensure `skills/manifest.json` exists for that skillpack when needed.
- Ensure each SKILL.md frontmatter `name:` matches the manifest skill name and path-derived class name, e.g. `agent-browser`, not `Agent Browser`.
- Verify with `gbrain check-resolvable <workspace>/skills --json` before rerunning `gbrain doctor --json`.

## Orphans and stale pages interpretation

Health orphan definition in gbrain engine: a page is orphaned when it has no inbound links and no outbound links. Large orphan counts often come from raw `inbox/feed/*` captures. These pages may still be semantically searchable if embeddings are complete, but they do not contribute to graph traversal or entity context.

Stale page definition: page `updated_at` is older than its latest `timeline_entries.created_at`. This usually means extraction added timeline evidence after the page body/compiled truth was last synthesized. Common after `gbrain extract all`.

Before promising to "fix all" orphans/stale pages, classify where they are by domain/type. Raw feed inbox backlog may call for scoring exclusion, archive policy, or hub linking rather than rewriting thousands of pages.