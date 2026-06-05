# Industry OS sector hub completion checklist

Use when Panda asks to complete the 台股 / 美股 stock database, not just enrich one ticker.

## Goal shape

Completion means decision-grade sector hubs first, full long-tail completeness later.

A hub is P0-complete when it has:

- exactly one H2 `## Research OS Coverage`;
- frontmatter `updated` set to the work date;
- a clear value chain and bottleneck map;
- demand owners and purchase / capex triggers;
- monitoring sources and weekly report hooks;
- an opportunity map separating fastest growth, overcrowded, undercovered, and open questions;
- citations to existing brain pages or `[Source: industry brain, YYYY-MM-DD]` when synthesizing from current brain content.

## Required `Research OS Coverage` fields

Each P0 hub should include these labels:

- `Industry Map`
- `Company Pool`
- `Value Chain`
- `Demand / Pain Points`
- `Keywords / Narratives`
- `Content / Traffic Signals`
- `Monitoring Sources`
- `Opportunity Map`
- `Weekly Reports`

## 2026-06-04 P0 set

TW P0 hubs:

- `topics/stocks/ai-server-tw-2026.md`
- `topics/stocks/pcb-substrate-tw-2026.md`
- `topics/stocks/semi-packaging-test-tw-2026.md`
- `topics/stocks/heavy-electric-grid-tw-2026.md`
- `topics/stocks/cooling-thermal-tw-2026.md`
- `topics/stocks/power-supply-tw-2026.md`
- `topics/stocks/memory-tw-2026.md`

US P0 hubs:

- `topics/stocks/ai-infra-us-2026.md`
- `topics/stocks/hyperscaler-capex-us-2026.md`
- `topics/stocks/semicap-us-2026.md`
- `topics/stocks/advanced-packaging-us-2026.md`
- `topics/stocks/energy-transition-us-2026.md`
- `topics/stocks/dc-reit-us-2026.md`
- `topics/stocks/glp1-obesity-us-2026.md`
- `topics/stocks/healthcare-broad-us-2026.md`
- `topics/stocks/defense-aerospace-us-2026.md`

## Topic-specific examples

- AI server / AI infra: split GPU, ASIC, HBM, networking, server / rack, power, cooling, DC REIT / colocation.
- Hyperscaler capex: map MSFT / GOOGL / AMZN / META / ORCL demand owners to supply-chain beneficiaries and ROI risk.
- Packaging / PCB / semicap: explicitly separate CoWoS, SoIC, ABF, TGV, CPO, WFE, EUV, High-NA, China controls, and tool bottlenecks.
- Power / DC REIT: include power availability, interconnect queue, gas turbines, nuclear, PPA economics, lease-up / FFO links.
- GLP-1 / healthcare: include demand owner, adherence, payer economics, PBM / employer / patient layers, and second-order effects.
- Defense: separate traditional prime backlog / cost-plus / platform delivery from defense-tech software / autonomy / milestone revenue.

## Verification pattern

After editing, run deterministic checks equivalent to:

- each file has exactly one H2 starting with `## Research OS Coverage`;
- each file has frontmatter `updated` containing today's date;
- `gbrain capture --file <file> --slug <slug> --type topic` succeeds for each modified file;
- `gbrain get <slug>` or `gbrain query <coverage phrase>` retrieves the new coverage;
- `git diff --check -- <modified files>` returns clean.

Do not trust only the subagent summary. If the agent framework reports a file-mutation verifier warning, verify file contents locally before calling the branch complete.

## P1 after P0

Once master pages say `P0 已完成（YYYY-MM-DD）`, move to company dossier coverage:

- sector position;
- revenue driver / revenue mix;
- customer concentration;
- margin and cash-flow quality;
- latest verified events;
- linked sector hub;
- ETF exposure for US where relevant.
