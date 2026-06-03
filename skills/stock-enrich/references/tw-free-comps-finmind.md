# TW free comps with FinMind + preview-safe Excel

Use this reference when Panda asks for analyst-style reports, comparable-company analysis, valuation spread, or a free fork of institutional financial-modeling workflows for Taiwan stocks.

## Durable lessons from stock-radar comps prototype

### Free data coverage is enough for basic comps

FinMind free API can support a usable Taiwan listed-company comps layer:

- `TaiwanStockFinancialStatements`: Revenue, CostOfGoodsSold, GrossProfit, OperatingExpenses, IncomeAfterTaxes, EPS, etc.
- `TaiwanStockBalanceSheet`: CapitalStock, CashAndCashEquivalents, borrowings/bonds, Equity, TotalAssets, etc.
- `TaiwanStockPrice`: latest close and daily price history.

This is enough for:

- TTM Revenue
- Gross / operating / net margin
- EPS TTM
- Market cap, using `CapitalStock / 10 * close` for ordinary Taiwan NT$10 par shares
- P/E, P/B, P/S, EV/Revenue
- Peer-set median / max / min
- Sector or theme valuation spread in stock-radar

Still missing vs institutional sources:

- Analyst consensus estimates
- Clean beta / cost of equity / WACC benchmarks
- Segment-level revenue and industry-specific KPIs
- Normalized non-recurring item adjustments

### Preview-safe Excel rule

For Telegram-delivered or Quick Look-previewed analyst reports, write static computed values, not formulas.

`openpyxl` can write formulas, but it does not calculate cached formula results. Telegram preview, macOS Quick Look, and Numbers can show formula cells as blank or `0` until Excel recalculates. This caused P/E, P/B, P/S, and EV/Revenue columns to appear as zeros.

Use formulas only for interactive Excel models where the user will open Excel and recalculate. For bot reports, compute in Python first and write the numeric value.

### FinMind operating-income data quality pitfall

Do not blindly trust `OperatingIncome` from `TaiwanStockFinancialStatements` for every issuer/period.

Observed case: `6770` PSMC had periods where FinMind's reported `OperatingIncome` materially disagreed with the statement structure and could exceed GrossProfit, making `Op Margin > Gross Margin`.

Safer comps normalization:

```python
normalized_operating_income = GrossProfit - OperatingExpenses
```

When both `GrossProfit` and `OperatingExpenses` exist, prefer this normalized value for operating margin. Keep a `DQ Flag` when reported OperatingIncome materially disagrees with the normalized value.

Suggested checks:

- Flag if `abs(reported_op - (gross - opex)) / max(abs(gross - opex), abs(gross), 1) > 10%`.
- Flag if Gross Margin is materially below Operating Margin after normalization.
- Flag if revenue is non-positive.
- Keep the raw mismatch in the report rather than silently hiding it.

### TTM construction

For quarterly rows, use the latest four available dates and sum flow items:

- Revenue
- GrossProfit
- OperatingIncomeNormalized
- IncomeAfterTaxes
- EPS

Use the latest balance sheet date for stock items:

- Equity
- Cash
- Debt
- CapitalStock

### Report shape

Add a `DQ Flag` column and keep it visible. A report that shows data-quality exceptions is more trustworthy than a clean-looking but silently wrong model.

Good default columns:

- Ticker
- Company
- Price Date
- Close
- Financial Period (TTM)
- Balance Date
- Revenue TTM
- Gross Margin
- Op Margin
- Net Margin
- EPS TTM
- Market Cap
- Book Equity
- P/E
- P/B
- P/S
- EV/Revenue
- DQ Flag

### Stock-radar integration idea

The useful product layer is not a standalone spreadsheet. It is:

`theme heat + institutional flow + valuation spread + brain thesis`

Example interpretation pattern:

> Theme is hot today, but valuation spread is wide: the leader trades at a premium while laggards cluster at lower sales/book multiples. If institutional buying concentrates in low-multiple names, frame it as catch-up / re-rating; if it concentrates in the leader, frame it as quality premium / risk-off concentration.
