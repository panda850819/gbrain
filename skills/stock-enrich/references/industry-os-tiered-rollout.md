# Industry OS tiered rollout for industry-db

Use this when Panda asks to complete, standardize, or continue the Taiwan/US `industry-db`, especially with P0/P1/P2 wording.

## User expectation

When scope is clear, keep going across all tiers. Do not stop after one batch and wait for another prompt. Report completed tiers and remaining backlog only after verification.

## Tier definitions

- **P0**: Core sector hubs that drive the market map. Goal is not every company, but an operating dashboard.
  - Add `## Research OS Coverage` if absent.
  - Add `### Sector Metrics / P0 operating dashboard`.
  - Metrics should be sector-specific: monthly revenue, backlog/utilization, capex phase, customer concentration, margin/cash conversion, and cross-hub bottlenecks.
- **P1**: Adjacent high-signal hubs and company dossiers that connect to P0 themes.
  - Add `### Sector Metrics / P1 operating dashboard`.
  - Company pages need `Decision-grade coverage`: sector position, revenue driver, customer concentration, margin/cash-flow quality, latest verified events, linked hubs, open questions.
- **P2**: Long-tail sectors and companies.
  - Add `## Research OS Coverage — P2 lightweight`.
  - Do not pretend completeness. Define upgrade gates: demand shock, repeated metric change, or cross-hub trigger from P0/P1.
  - For dangling companies, create minimal `coverage_tier: P2-watchlist` dossiers only for high-signal links. Put the rest in a backlog page.

## Canonical workflow

1. Read `concepts/industry-intelligence-operating-system.md`, TW/US sector masters, and relevant existing hub pages.
2. Patch P0 hubs first, then P1 hubs/company dossiers, then P2 lightweight coverage.
3. For dangling links:
   - fix topic links that were misfiled as `../../companies/<topic-slug>`;
   - canonicalize old company slugs by ticker when a unique company page exists;
   - create P2 watchlist company pages for repeated/high-signal missing company links;
   - write the remaining candidates to `topics/stocks/tw-stock-dangling-priorities-2026.md` or equivalent backlog.
4. Capture with explicit type. Never use `--type auto`:
   - `companies/* -> company`
   - `topics/* -> topic`
   - `concepts/* -> concept`
   - `supply-chain/* -> supply_chain`
   - `reports/* -> report`
5. Verify before final response:
   - `gbrain frontmatter validate . --json`, ignoring only structural rule files like `RESOLVER.md` if expected;
   - changed files have no `^type:\s*auto$`;
   - old slug references are zero for the canonicalization set used;
   - `gbrain capture` succeeds for every modified markdown file;
   - `gbrain query` retrieves representative P0 metrics, P2 lightweight coverage, and a P2 watchlist company.

## Output shape

Keep the final report short:

- tiers completed and counts;
- key files/sections changed;
- verification results;
- remaining backlog rule, not a giant raw list.

Avoid over-reporting every file when hundreds changed. Mention representative paths and the backlog page.