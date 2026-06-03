# Fundamental Thesis Check — Brain-aware stock reasoning

Use this reference inside `stock-enrich` when Panda asks for investment logic, fundamental analysis, same-industry comparison, control points, or whether a company/sector is worth researching.

## Principle

Brain is a reasoning substrate, not a Bloomberg clone. Do not auto-backfill volatile quarterly numbers into hubs. Use existing Brain pages to test whether the investment logic is coherent, what evidence is missing, and what kind of thesis it is.

Panda's current framing:
- Operating-company quality: cash flow matters.
- Short-term breakout / re-rating: control points and the ability to create control points matter.
- Same-industry comparison is the training ground because similar business models make differences visible.

## Inputs

Accept any of:
- Ticker: `NVDA`, `PLTR`, `3374`
- Company name: `台積電`, `世芯`, `Navitas`
- Sector: `ASIC 設計服務`, `AI server power supply`
- Thesis prompt: `這家公司值不值得研究`, `基本面邏輯`, `控制點是什麼`

## Brain-first load order

1. `companies/<ticker-or-slug>.md`
2. Matching `topics/stocks/*sector*` hub
3. `topics/stocks/*valuation-comp*`
4. `topics/stocks/*major-events-timeline*`
5. Prior reports / dreams / sessions that mention the ticker or sector
6. Relevant media pages, especially fundamental-analysis or sector-framework pages

If a known page is missing, record it under `missing_brain_context`; do not fabricate.

## Comparable set

Build 3–5 comps from Brain, not memory:
- Same sector hub preferred.
- Same value-driver cluster second.
- Same customer / supply-chain exposure third.

If fewer than 3 credible comps exist, label the analysis `insufficient comps` and treat the output as a question list, not a conclusion.

## Core questions

Ask and answer:
1. How does this business make money?
2. Can that profit mechanism persist?
3. What would let it earn more in the future?
4. Why is A better than B within the same industry?
5. What is the industry's real value driver?
6. What control point does the company have?
7. Is the control point inherited, cyclical, structural, or created by management / organization capability?

## Three-lens analysis

### Cash-flow quality

Use for operating-company quality:
- revenue quality
- gross / operating margin durability
- free cash flow conversion
- ROIC / capital efficiency
- cyclicality
- capex and working-capital burden
- customer concentration risk

### Control points

Use for re-rating / breakout logic:
- customer lock-in
- bottleneck in supply chain
- technical threshold
- distribution / channel access
- pricing power
- regulatory / certification moat
- capacity scarcity
- data / workflow ownership

### Control-point creation ability

Use for builder / management bets:
- capital allocation track record
- product roadmap execution
- ability to enter key customers
- ability to move from commodity → module → solution
- repeatable operating engine
- evidence that one-off demand can become durable franchise

## Thesis type classifier

Always classify one primary type:

- `Cash-flow compounder`: durable cash generation and reinvestment quality drive the thesis.
- `Control-point re-rating`: market is discovering a structural bottleneck / scarcity / pricing-power position.
- `Cycle beta`: returns mostly depend on inventory, capex, subsidy, or macro cycle.
- `Builder/capital-allocation bet`: thesis mainly depends on management's ability to create new control points.
- `Too hard / insufficient data`: Brain lacks enough comps or first-party evidence.

## Output format

```markdown
# Fundamental Check: {company / sector}

## 1. Brain context
- Company page:
- Sector hub:
- Comparable set:
- Prior thesis / reports:
- Missing context:

## 2. How this business makes money

## 3. Durability of the profit mechanism

## 4. Same-industry comparison
- A vs B:
- Difference:
- Why it matters:

## 5. Value drivers

## 6. Control points

## 7. Control-point creation ability

## 8. Thesis type
Primary: Cash-flow compounder / Control-point re-rating / Cycle beta / Builder bet / Too hard
Why:

## 9. Questions before action

## 10. Brain writeback
- Report path:
- Pages that need update:
- Missing sources:
```

## Writeback rules

Preferred report path:
`reports/stocks/{ticker-or-sector}-fundamental-check-YYYY-MM-DD.md`

Write volatile data as source pointers, not stale hub values:
- `needs_source`
- `missing_comps`
- `questions_to_answer`
- source links to filings / IR / sector reports

Do not:
- give buy/sell advice unless Panda explicitly asks for a trading decision
- invent comps outside Brain without labeling them external hypotheses
- silently create new sector hubs
- write transient prices or quarterly figures into permanent hubs unless the page is explicitly a dated report
