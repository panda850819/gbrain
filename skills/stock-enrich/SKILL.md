---
name: stock-enrich
version: 1.0.0
description: |
  Look up a TW or US stock ticker (or Chinese company name) and enrich the INDUSTRY
  brain's companies/<ticker>.md page with current financials, executives, and recent news,
  then cross-link into the matching topics/stocks/<sector>-<tw|us>-2026.md sector hub.
  Operates on the industry brain (~/site/knowledge/industry-db/), NOT the personal brain.
  Auto-routes on ticker mentions like "NVTS 有什麼消息嗎"、"把這 5 檔的全名跟操盤人查一下補上"、
  "PLTR 補一下"、"2330 補近期新聞".
triggers:
  - "<TICKER> 有什麼消息嗎"
  - "<TICKER> 補一下"
  - "<TICKER> 是什麼"
  - "把 N 檔的全名跟操盤人查一下"
  - "操盤人"
  - 訊息含單一美股 ticker (例如 NVTS / PLTR / TSM)
  - 訊息含單一台股 4-digit ticker (例如 2330 / 6770)
  - 訊息含中文股票名（帕蘭泰爾 / 台積電 / 緯創）
  - "<某類股> 有哪些標的"
  - "標的"
  - "基本面邏輯"
  - "投資 thesis"
  - "同產業比較"
  - "控制點"
  - "現金流"
tools:
  - search
  - query
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
  - WebSearch
  - WebFetch
mutating: true
writes_pages: true
writes_to:
  - companies/
  - topics/stocks/
---

# Stock Enrich Skill

## Brain target — INDUSTRY brain (not personal)

Since the 2026-05-29 two-brain split, ticker dossiers (`companies/<ticker>.md`) and
sector hubs (`topics/stocks/*`) live in the **industry brain** (`~/site/knowledge/industry-db/`),
NOT the personal brain. This skill operates ENTIRELY on the industry brain. Route every
operation accordingly — getting this wrong re-pollutes the personal brain with the exact
data the split removed:

- **MCP tools** (`search` / `query` / `get_page` / `put_page` / `add_link` / `add_timeline_entry`):
  use the `mcp__gbrain_industry__*` server, NOT `mcp__gbrain__*`. (Claude-Code-only; if that
  server isn't loaded this session, fall back to the CLI below.)
- **CLI**: prefix EVERY `gbrain` call with `GBRAIN_HOME=~/site/knowledge/industry-db`,
  e.g. `GBRAIN_HOME=~/site/knowledge/industry-db gbrain query "<ticker>"`. Hybrid query
  needs the OpenAI key at query time — in a terminal use `zsh -lc 'source ~/.zshrc; GBRAIN_HOME=… gbrain query "…"'`.
- **File paths**: all `companies/`, `topics/stocks/`, `reports/stocks/` paths in the phases
  below are relative to `~/site/knowledge/industry-db/`, not the personal brain.
- **Exception — people/**: executives are personal-relationship entities; `people/*` stays in
  the PERSONAL brain. Keep executive wiki-links as cross-brain markdown links; do NOT create
  `people/` pages in industry-db (its RESOLVER forbids them). Any `enrich`-skill delegation for
  a people stub targets the personal brain.

> **Filing rule:** Read `~/site/knowledge/industry-db/RESOLVER.md` before creating any new page.
> **Fundamental thesis mode:** When Panda asks for investment logic, fundamental analysis, same-industry comparison, cash flow, control points, or "值不值得研究", use the Brain-aware thesis workflow in `references/fundamental-thesis-check.md` instead of only enriching current facts.
> **Financial comps / valuation data quality:** When building comps, valuation snapshots, or analyst-facing stock reports from free/open data such as FinMind, use `references/financial-comps-data-quality.md`: normalize raw vendor rows into canonical statement fields, include TW IFRS fields like `OTHNOE`, run invariant checks, and use human-facing labels such as `資料品質註記` instead of engineering jargon.

## Contract

For any TW/US ticker mention (Chinese or English, full name or symbol), this skill guarantees:

- A `companies/<slug>.md` page exists with the canonical schema (frontmatter `type=company`, `aliases` array including EN + ZH + ticker, `ticker` in `EXCHANGE:SYM` format, `sector`, `sub_sector`, executives, business overview, recent verified news).
- The page is cross-linked from the matching `topics/stocks/<sector>-<tw|us>-2026.md` sector hub (ticker added to `ticker_set` if missing).
- All tickers in a multi-ticker ask are resolved before reporting done.
- Every claim cited to one source. No silent invention.

## Trigger detection (auto-route)

Fire when any of the following appears in the user message:

- Single US ticker pattern: `\b[A-Z]{1,5}\b` adjacent to 股 / ticker / 標的 / 是什麼 / 補一下 / 有什麼消息 / 操盤人 / CEO / 執行長.
- Single TW ticker: `\b[1-9]\d{3}\b` adjacent to 台股 / 個股 / 上市 / 上櫃.
- Chinese company name resolvable to an `aliases` entry in an existing `companies/*.md` (probe with `gbrain query`).
- Phrases: 操盤人, 執行長, CEO, 創辦人, 全名 + ticker context.

Skip when the message is about a sector / index / macro topic without a specific ticker — that goes through `brain-ops` + manual write, not this skill.

## Fundamental thesis mode — Brain-aware reasoning check

Use this mode when Panda asks about:
- 基本面邏輯 / 投資 thesis / 這家公司值不值得研究
- 同產業比較 / comparable set / A 為什麼比 B 好
- 現金流 / control point / 控制點 / 短期爆發

Do **not** treat this as a live-price call or automatic recommendation. The output is a reasoning check that uses Brain pages as the substrate.

Workflow summary:
1. Brain-first: load company page, sector hub, valuation comp, major-events timeline, and related prior thesis pages.
2. Build a 3–5 company comparable set from the same sector hub. If Brain lacks enough comps, say `insufficient comps` and list what is missing; do not invent.
3. Ask the Vincent Yu fundamental-analysis questions:
   - Why does this company make money?
   - Can that profit mechanism persist?
   - What would let it earn more in the future?
   - Why is A better than B within the same industry?
   - What is the real value driver of this industry?
4. Separate the thesis into three lenses:
   - Cash-flow quality: revenue quality, margin durability, FCF, ROIC, cyclicality, capex / working-capital burden.
   - Control points: customer lock-in, bottleneck position, technical threshold, channel, pricing power, regulation / certification, capacity scarcity.
   - Control-point creation ability: management capital allocation, roadmap, customer-entry ability, move from commodity to module/solution, repeatable engine.
5. Classify thesis type: `Cash-flow compounder`, `Control-point re-rating`, `Cycle beta`, `Builder/capital-allocation bet`, or `Too hard / insufficient data`.
6. Prefer writing an analysis report under `reports/stocks/{ticker-or-sector}-fundamental-check-YYYY-MM-DD.md`. Do not stuff volatile financial numbers into sector hubs. If data is missing, write `needs_source`, `missing_comps`, and `questions_to_answer` instead.

Full procedure and template: `references/fundamental-thesis-check.md`.

## Taiwan free comps / analyst-report mode

When Panda asks whether institutional financial-modeling workflows can be forked for free, or asks for analyst-style reports using Taiwan stocks, use `references/tw-free-comps-finmind.md`.

Key defaults:
- FinMind free data is enough for a basic Taiwan comps layer: TTM revenue, margins, EPS, market cap, P/E, P/B, P/S, EV/Revenue.
- For Telegram-delivered or Quick Look-previewed xlsx reports, write static computed values, not Excel formulas. `openpyxl` writes formulas but does not calculate cached results, so previews can show blank/0 formula cells.
- Normalize operating income as `GrossProfit - OperatingExpenses` when FinMind's reported `OperatingIncome` materially disagrees with statement structure. Keep the mismatch in a visible `DQ Flag` column instead of silently trusting or hiding it.
- Treat `DQ Flag` as part of the deliverable. Analyst-quality output surfaces data-quality exceptions.

## Phases

### Phase 1 — Resolve ticker(s)

1. List all candidate tickers in the message (US symbols + TW 4-digits + Chinese names).
2. For Chinese names: `gbrain query "<name>"` → match to existing `companies/*.md` aliases.
3. For each ticker, determine market & exchange:
   - US: NYSE / NASDAQ / OTCMKTS — WebSearch `<TICKER> stock exchange` if unknown.
   - TW: TWSE (上市) vs TPEX (上櫃) — confirm via TWSE / 公開資訊觀測站.
4. Page slug convention (match existing brain — never invent):
   - US: lowercase ticker (e.g., `pltr.md`, `aapl.md`).
   - TW: `<英文簡稱>-<4-digit>.md` (e.g., `tsmc-2330.md`, `mediatek-2454.md`) **only when** the brain already files TW companies this way. Otherwise lowercase ticker.

### Phase 2 — Brain-first lookup

For each ticker: `gbrain query "<ticker> <company-name>"`. If `companies/<slug>.md` exists, READ it before writing. Absorb-first: update existing rather than create-new when overlap ≥60%.

### Phase 3 — Web enrich

WebSearch each ticker for:

- 英文 / 中文全名
- Current CEO / 董事長 / CTO / President (with appointment date if recent)
- Sector + sub_sector
- 2-3 latest news items (each with source URL + date)
- Market cap, last earnings date (quarter)
- Founding year, listing date

**One source per fact.** If multiple sources disagree (e.g., conflicting CEO names), write the most-recent date-stamped one and flag the conflict in `sources:` as "待確認 <issue>".

### Phase 4 — Write / update companies/<slug>.md

Use canonical schema (reference `companies/pltr.md`):

```yaml
---
type: company
aliases: ["<EN-full>", "<EN-short>", "<TICKER>", "<中文全名>", "<中文簡稱>"]
ticker: "<EXCHANGE>:<TICKER>"
sector: <sector>
sub_sector: <sub-sector>
group: null
listed_date: "<YYYY-MM-DD or null>"
created: <today>
updated: <today>
sources:
  - <each source URL or descriptor, one per line>
tags:
  - <us-stock | tw-stock>
  - <sector tags>
---
```

Body structure (in this order):

1. `# <英文全名>（<中文全名>, <TICKER>）`
2. 1-2 sentence positioning tagline.
3. `## 為什麼這頁存在` — one paragraph: why this ticker matters now, what hub it belongs to.
4. `## 基本資料` — markdown table with rows: 中文全名 / 英文全名 / Ticker / 成立 / 上市 / 集團 / 創辦人 / 董事長 / CEO / CTO / 員工數 / 總部 / 主要據點.
5. `## 業務` — what the company does, customer mix, revenue split.
6. `## 近期重點 (verified)` — bullet list of news items with citations.

Wiki-link executive names to `people/<slug>.md` (e.g., `[[../people/alex-karp|Alex Karp]]`). Create the `people/` stub via `enrich` skill if missing — do not pre-populate unverified people pages from this skill.

### Phase 5 — Sector hub cross-link

1. Determine sector hub slug: `topics/stocks/<sector-or-sub_sector>-<tw|us>-2026.md`. Common slugs:
   - US: `ai-infra-us-2026`, `ai-server-us-2026`, `hyperscaler-capex-us-2026`, `defense-us-2026`, `biotech-us-2026`
   - TW: `ai-server-tw-2026`, `apple-chain-tw-2026`, `auto-parts-tw-2026`, `biotech-medical-tw-2026`, `cement-tw-2026`
2. If hub exists:
   - Read frontmatter `ticker_set` array.
   - If `<EXCHANGE>:<TICKER>` not present, add it.
   - Bump frontmatter `updated:` to today.
   - Save.
3. If hub does NOT exist: **STOP**. Opening a new sector hub is a strategic taxonomy decision — file a note in `inbox/sector-hub-gap-<topic>.md` and ask Panda whether to open one.
4. From the company page body, add a wiki-link back to the hub: `[[../topics/stocks/<hub>|<hub title>]]`.

### Phase 6 — Backlinks & timeline

- `gbrain add_link <company-slug> --to <hub-slug> --type "tagged_in"`
- `gbrain add_timeline_entry <company-slug> "<today>: enriched via stock-enrich skill"` (one line, lightweight).

## Anti-patterns

- **No invented executives or financials.** Every fact cited, or omitted with a "待確認" flag.
- **No silent new sector hubs.** Pause and ask before opening one.
- **No per-news-item brain pages.** News belongs in the company page's `近期重點` section, not as standalone files.
- **No re-enrich without consent.** If `updated:` is within 7 days, ask Panda before re-running.
- **No partial multi-ticker reports.** If the user asks about 5 tickers, finish all 5 before reporting.

## Output

After all phases for all tickers:

- List of pages written / updated (path + 1-line diff summary).
- Sector hub `ticker_set` additions.
- Any "待確認" flags raised.
- People-page stubs that should be opened next (delegate to `enrich`).
