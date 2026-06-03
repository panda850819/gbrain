# Financial Comps Data Quality

Use this reference when building free/open-data comparable-company analysis, valuation snapshots, or analyst-facing stock reports.

## Core lesson

Free/open financial data can be good enough for analyst-style reports, but never pass raw vendor rows directly into valuation metrics. Build a canonical statement adapter first, then run invariant checks, then generate the report.

Pipeline:

```text
raw vendor rows -> canonical statement adapter -> invariant checks -> normalized metrics -> analyst-facing report
```

## FinMind TW statement adapter notes

For Taiwan equities using FinMind:

- Income statement rows are keyed by `type` and `date`.
- TTM metrics should usually sum the latest four statement periods.
- Market cap can be approximated with `CapitalStock / 10 * close` for Taiwan common shares, unless a better share-count source is available.
- Do not assume textbook US formulas are sufficient for Taiwan IFRS presentation.

Canonical fields:

- `revenue` <- `Revenue`
- `cost_of_goods_sold` <- `CostOfGoodsSold`
- `gross_profit` <- `GrossProfit`, or `Revenue - CostOfGoodsSold` as cross-check
- `operating_expenses` <- `OperatingExpenses`
- `other_operating_income_expense` <- `OTHNOE` (`其他收益及費損淨額`)
- `operating_income_normalized` <- `GrossProfit - OperatingExpenses + OTHNOE`
- `net_income` <- `IncomeAfterTaxes`
- `eps` <- `EPS`
- `cash` <- `CashAndCashEquivalents`
- `debt` <- `LongtermBorrowings + BondsPayable` as a first pass
- `equity` <- `EquityAttributableToOwnersOfParent` preferred, else `Equity`

Important pitfall: `OperatingIncome` in FinMind may look inconsistent if you forget `OTHNOE`. Example: 6770 2026Q1 had large `OTHNOE`, so `GrossProfit - OperatingExpenses` looked negative while reported `OperatingIncome` was positive. Correct formula including `OTHNOE` reconciled.

## Invariant checks

Hard failures, exclude metric or row:

- Missing or non-positive revenue.
- Missing price or share count.
- EPS <= 0 for P/E.
- Equity <= 0 for P/B.

Soft warnings, keep row but annotate:

- Vendor `OperatingIncome` still disagrees with `GrossProfit - OperatingExpenses + OTHNOE` beyond tolerance.
- Operating margin exceeds gross margin because `OTHNOE` is large; this may be valid but should be noted as non-core/non-typical.
- Net margin exceeds operating margin materially, unless non-operating gains explain it.
- TTM period has fewer than four periods.

## Human-facing report language

Do not expose engineering jargon in analyst-facing reports.

Use:

- Column: `資料品質註記`
- Clean rows: `OK`
- Warning example: `營業利益率高於毛利率，通常是其他收益及費損影響，需人工複查`

Avoid:

- `DQ Flag`
- stack-trace style errors
- raw field names unless needed for audit notes

## Output mode

For bot-delivered reports or Telegram attachments:

- Prefer static values in `.xlsx`; do not rely on Excel formulas unless you also recalculate and verify cached values.
- `openpyxl` writes formulas but does not calculate cached results. Telegram preview, macOS Quick Look, and Numbers may show formula cells as blank or 0.
- If interactivity is required, run a real recalculation step and verify no formula errors before delivery.

## Testing pattern

Every discovered data quirk should become a regression fixture:

- Fixture for `OTHNOE` inclusion.
- Fixture for true vendor mismatch after canonical formula.
- Fixture for TTM summing latest four periods.

The goal is not to hand-patch every ticker. The goal is to grow the canonical adapter until most quirks are handled before the analyst report layer sees the data.
