# Resolver Health Remediation Notes

Use when `gbrain doctor --json` reports `resolver_health` failures or warnings for skill reachability.

## Durable pattern

`resolver_health` parses resolver rows from Markdown tables, not informal bullet lists. If a skill exists on disk but doctor says it is unreachable, make the relevant `AGENTS.md` or `RESOLVER.md` section a table:

```md
## Brain operations

| Trigger | Skill |
|---|---|
| browser automation, web scraping, headless browser, agent-browser | `skills/agent-browser/SKILL.md` |
```

Then verify with:

```bash
gbrain check-resolvable /path/to/skills --json
gbrain doctor --json
```

## Manifest and naming pitfalls

- If a skillpack lacks `skills/manifest.json`, doctor may warn `manifest.json not found` or report orphan triggers. Add a small manifest listing each skill with `name`, `path`, and `description`.
- Skill names should match their directory-level class name. Example: `skills/agent-browser/SKILL.md` should use `name: agent-browser`, not `name: Agent Browser`, otherwise resolver checks can treat the table row as orphaned or mismatched.
- Do not remove a valid resolver row just because doctor suggests `remove_trigger` for an orphan. First check whether the manifest/name is missing or mismatched.

## Related cleanup sequence

When a hygiene job reports both sync and resolver problems, this order worked well:

1. Fix resolver table / manifest / skill names.
2. Run `gbrain check-resolvable <skills-dir> --json` until errors and warnings are zero.
3. Retry or acknowledge old sync failures as appropriate.
4. Run `gbrain extract all --source db` after large imports.
5. Run embeddings from a shell that loads the user env, e.g. `zsh -lc 'source ~/.zshrc >/dev/null 2>&1; gbrain embed --stale'`, when API keys live in shell startup or Keychain export.
6. Verify with `gbrain doctor --json` and `gbrain health`.
