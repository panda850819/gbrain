# GBrain pack upgrade and onboard remediation notes

Use when `gbrain doctor` reports `pack_upgrade_available`, or when Panda asks to run `gbrain onboard upgrade` / clear doctor warnings after a pack bump.

## Key lessons

- `gbrain onboard --upgrade` may only render recommendations. Do not assume it applied the pack migration.
- The pack migration can be a protected Minion job. The concrete command surfaced by `gbrain onboard --check --explain` may be:

```bash
gbrain jobs submit unify-types --allow-protected --params '{"target_pack":"gbrain-base-v2"}' --follow
```

- After `unify-types`, always run:

```bash
gbrain extract --stale
gbrain doctor --scope=brain
```

Pack migrations can retype many pages and make hundreds of pages stale for graph extraction.

## Verification checklist

1. Confirm active pack changed in doctor output, e.g. `pack_upgrade_available: OK`.
2. Confirm `type_proliferation` is OK and distinct type count dropped to the expected canonical range.
3. Confirm `links_extraction_lag` is `0/N` after `gbrain extract --stale`.
4. Confirm `extract_atoms_backlog` status again. A legacy-pack backlog can disappear after type unification because eligibility changes under the canonical taxonomy.
5. Confirm working tree state separately. DB migrations may not create git diffs, but temp inspection scripts should be removed.

## Pitfall: `onboard --auto` loop

If `gbrain onboard --auto --yes --target-score ...` prints progress like `[300/2] sync` or repeats the same remediation far beyond the reported total, stop treating it as a normal long run. That indicates the onboard remediation orchestrator is looping or miscounting. Do not let it run indefinitely. Prefer the explicit protected job surfaced by `onboard --check --explain`, then verify with doctor.

## Notes on model config warning

`subagent_capability` may warn when `models.tier.subagent` is an OpenAI model because GBrain's cost optimization expects Anthropic prompt caching. This is not a functional blocker. If Panda does not want Claude for that tier, leave the config as-is and treat the warning as an acknowledged cost-policy warning, not something to auto-fix.
