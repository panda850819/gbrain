# Industry DB completion workflow

Use this when Panda asks to 完成 / 補齊 / next the 台股 or 美股 industry brain database, not just a single ticker.

## Core lesson

Do not stop after adding an operating-system layer or template. Panda's intent is usually completion progress in sequence. Treat the work as a multi-round database completion project:

1. **P0 sector hub coverage** — make the decision-critical sector hubs usable first.
2. **P1 company dossier coverage** — bring core companies under those hubs to decision-grade.
3. **P1 missing dossier queue** — only after existing files are covered, create or propose missing company dossiers.
4. **P2 long tail** — lower-liquidity or lower-relevance companies.

## P0 sector hub pattern

For each priority hub, add or update exactly one section:

```markdown
## Research OS Coverage — YYYY-MM-DD
```

Include:

- Industry Map
- Company Pool
- Value Chain
- Demand / Pain Points
- Keywords / Narratives
- Content / Traffic Signals
- Monitoring Sources
- Opportunity Map
- Weekly Reports

For stock hubs, also include the sector-specific judgment layer: value pool, bottleneck, replaceability, demand trigger, and monitoring loop.

## P1 company dossier pattern

For each existing company file, add or update exactly one section:

```markdown
## Decision-grade coverage — YYYY-MM-DD
```

Required fields:

- Sector position
- Revenue driver
- Customer concentration
- Margin / cash-flow quality
- Latest verified events
- Linked P0 hubs
- Open questions

Avoid inventing new exact numbers. Use existing brain facts and citations, or mark `[Source: industry brain, YYYY-MM-DD]` when synthesizing from current hub/company pages.

## Batching

Use independent batches so work can proceed in parallel without file overlap:

- TW AI server / power / connector company dossiers
- TW packaging / PCB / memory company dossiers
- US AI infra / hyperscaler capex / semicap / power company dossiers
- US healthcare / defense / DC REIT / energy company dossiers

For subagents, constrain scope to explicit file lists and say: existing files only, no external web, no commit.

## Parent verification

Do not trust subagent self-report. Verify in the parent session:

- target files exist;
- each modified hub has exactly one `## Research OS Coverage` H2;
- each modified company has exactly one `## Decision-grade coverage` H2;
- required fields are present;
- `updated:` frontmatter is current when applicable;
- run `gbrain capture` with `GBRAIN_HOME=~/site/knowledge/industry-db` for every changed page;
- query or get at least representative pages after capture;
- run `git diff --check` over changed files.

If a subagent reports a missing file but a similarly named ticker file exists, do not silently substitute unless Panda authorized that specific slug. Record skipped missing targets and make the missing dossier queue the next phase.

## Master page bookkeeping

After a P0/P1 batch completes, update the relevant master page (`tw-stock-sectors-master-2026.md` or `us-stock-sectors-master-2026.md`) from "priority queue" to "P0/P1 completed" and capture it.
