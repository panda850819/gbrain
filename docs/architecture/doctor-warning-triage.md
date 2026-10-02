# Doctor warning triage

`gbrain doctor` checks expose two related but distinct signals:

- `status`: the legacy per-check health state, one of `ok`, `warn`, or `fail`.
  It remains in the JSON contract for existing consumers.
- `severity`: an optional additive triage state used by scoring, issue ranking,
  and human rendering.

## Severity values

| Severity | Meaning | Affects aggregate health? |
|---|---|---:|
| `ok` | No issue observed | No |
| `info` | Historical or audit-only information | No |
| `expected` | Deliberately disabled or expected by the current topology/configuration | No |
| `coverage_gap` | The system cannot currently observe or schedule a capability | No |
| `needs_human` | Governance or canonicalization decision is pending | No |
| `warn` | Current actionable degradation | Yes, `-5` |
| `fail` | Current hard failure | Yes, `-20` |

A check can retain `status: "warn"` and set a non-actionable `severity` so old
consumers still see the historical warning state while new consumers can tell
that it is not a live production outage. A `status: "fail"` is fail-closed and
always scores as `fail`, even if an invalid or stale informational label is
attached.

## Aggregate behavior

`health_score`, `brain_checks_score`, and each `category_scores` value use the
resolved `severity`. Checks without an explicit `severity` retain the legacy
formula:

```text
100 - 20 * actionable_failures - 5 * actionable_warnings
```

`top_issues` contains only resolved `warn` and `fail` checks. Non-actionable
triage states remain in `checks` and in human output, but they do not create a
production incident or a remediation-ranked issue.

## Current reclassifications

- `reranker_health`: when the reranker is disabled, recent failure rows are
  retained as `info` historical audit data. Enabled reranker failures remain
  actionable.
- `conversation_parser_probe_health`: a configured probe with no recent event
  is `coverage_gap`; disabled probe is `expected`; historical failures followed
  by a passing latest run are `info`; a latest non-pass remains actionable.
- `subagent_capability`: missing native Anthropic subagent access is `expected`
  only when both local semantic schedulers are explicitly disabled. Unset or
  unreadable gates retain the warning, and explicitly invalid model capability
  warnings are not downgraded.
- `extract_atoms_backlog`: an unscheduled backlog is `coverage_gap` and keeps
  the count plus drain hint. The backlog is not deleted or reported as drained.

These classifications do not change the underlying audit rows, phase gates,
provider routing, runtime topology, or remediation commands. They only make
current impact and follow-up ownership explicit.

## Consumer contract

Local `gbrain doctor`, `gbrain remote doctor`, and `gbrain skillpack-check` all
use the resolved severity. JSON clients should prefer `severity` when present
and fall back to `status` when it is absent. A client that only understands the
legacy `status` field remains compatible, but will not see the newer triage
meaning until it reads `severity`.
