# Adding Per-Run Judgment Ledger Entries to Deterministic Scripts

The source-intake judgment ledger (`.raw/source-intake/judgment-ledger.jsonl`) captures
*what happened* in each run, not just *that a cron job ran*. This reference documents
the reusable pattern for adding rich judgment entries to deterministic Python scripts.

## When to Add Per-Run Judgment

A script should write its own judgment entry when:
- It produces output with topology value to Panda's brain (not just pass-through plumbing).
- The default P1 cron session record ("cron ran with N messages") is too thin to be useful.
- Examples: health data ingested, market data collected, enrichment backfills completed.

Scripts that should NOT add per-run judgment:
- Pure watchdogs that only alert on failure (already self-documenting).
- High-frequency scripts where per-run ledger volume would dominate (e.g., every-10-min pollers).
- Pass-through scripts with no domain-specific data.

## Helper Function Template

```python
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

LEDGER_SCRIPT = str(Path.home() / ".hermes" / "scripts" / "source-intake-ledger.py")


def append_judgment_entry(entry_data: dict[str, Any]) -> None:
    """Best-effort append to judgment ledger. Never blocks the main script."""
    try:
        subprocess.run(
            [
                sys.executable,
                LEDGER_SCRIPT,
                "--entry", json.dumps(entry_data, ensure_ascii=False),
                "--skip-existing",
            ],
            check=False,
            capture_output=True,
            timeout=10,
        )
    except Exception:
        pass  # ledger write failure must not block the primary function
```

## Judgment ID Convention

Format: `YYYYMMDD-{source-name}`

- `20260603-health-shortcut` — one per day per source
- `20260603-market-heartbeat` — daily market collection
- `20260603-health-enrich` — enrichment backfill run

The `--skip-existing` flag on `source-intake-ledger.py` ensures that if a cron job
retries on the same day, the entry is idempotent (no duplicates).

## Required Entry Shape

```python
entry = {
    "schema_version": "0.1",
    "judgment_id": f"{date_str}-source-name",
    "timestamp": datetime.now().isoformat(),
    "source": "source_name_matching_registry",
    "source_priority": "p1_local_activity",
    "source_id": f"source-name:{date_str}",
    "raw_ref": "path or description of the raw artifact",
    "summary": "rich one-line summary with actual values from this run",
    "linked_nodes": ["brain/slug/for/this/data"],
    "decision_type": ["source"],
    "routing": ["digest"],  # or ["digest", "backlink"] if a brain page was written
    "judgment_reason": "why this specific run is worth recording",
    "model_or_agent": "script:script-name.py",
    "gate_version": "source-intake-v0.1",
    "review_status": "unreviewed",
    "review_note": None,
}
```

## Source Registry Registration

Every new `source` value must be registered in `.raw/source-intake/source-registry.yaml`
under the appropriate priority level before the script writes entries. Example:

```yaml
health_shortcut:
  status: active
  privacy: personal_data
  default_route: digest
  allowed_routes: [raw_only, digest, backlink, brain_page]
  linked_domains: [health, personal_ops]
  notes: "iOS Shortcut → n8n → JSONL pipeline."
```

## Concrete Examples

### health_shortcut_ingest.py — new data arrives

```python
entry = {
    "judgment_id": f"{date}-health-shortcut",
    "source": "health_shortcut",
    "summary": f"Health shortcut: {steps} steps, {sleep_h}h sleep, active {active} kcal, DQ: {dq_str}",
    "linked_nodes": [f"personal/health/logs/{date}-shortcut-health"],
    "routing": ["digest", "backlink"],
    "judgment_reason": "Daily health data from iOS Shortcut → n8n pipeline; backlinks to daily log page.",
}
```

### market-heartbeat-data.py — data collection complete

```python
entry = {
    "judgment_id": f"{date_str}-market-heartbeat",
    "source": "market_heartbeat",
    "summary": f"Market heartbeat: VIX {vix}; S&P {spx_pct}%; BTC ${btc}; F&G {fg}; {top_movers}",
    "linked_nodes": ["personal/finance/market-heartbeat"],
    "routing": ["digest"],
    "judgment_reason": "Daily cross-market heartbeat for morning context.",
}
```

### health-jsonl-enrich.py — backfills completed

```python
entry = {
    "judgment_id": f"{date_str}-health-enrich",
    "source": "health_apple_export",
    "summary": f"Health enrichment: backfilled {len(changes)} fields for {date_range}",
    "linked_nodes": ["personal/health/raw/apple-health-shortcut"],
    "routing": ["digest"],
    "judgment_reason": "Backfill blank health fields from Apple Health export.xml.",
}
```

## P1 Cron Session vs Per-Run Rich Entry

These are complementary, not duplicates:

| Layer | Source | Entry says |
|---|---|---|
| P1 cron session scan | `source-intake-local-activity.py` | "Hermes session from cron with N messages and M tool calls" |
| Per-run rich entry | The script itself | "Health shortcut: 8,432 steps, 6.2h sleep, active 420 kcal, DQ: OK" |

The P1 scan gives the time-anchor (when did this run?), the per-run entry gives the content
(what actually happened?). Together they enable meaningful weekly review.

## Pitfalls

- **Blocking the main function**: The `append_judgment_entry()` call must be wrapped in
  try/except and never raise. Ledger writes are best-effort.
- **Wrong priority**: Local scripts are `p1_local_activity`, not `p3_semi_auto_sources`.
  The priority reflects the collection mechanism, not the data origin.
- **Duplicate judgment_ids**: Always use `--skip-existing` to prevent duplicates from
  cron retries. Day-granularity IDs mean at most one entry per source per day.
- **Missing registry entry**: The `source` field value must exist in `source-registry.yaml`
  or future review tools won't be able to look up the source policy.
