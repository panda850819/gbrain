---
name: transcript-ingest
version: 1.0.0
description: |
  Capture AI conversation transcripts from Claude Code / Codex / Hermes jsonl,
  dedup, gate (signal vs noise with a novelty floor + durability test), and
  distill SIGNAL sessions into brain-ready domain-routed notes staged for manual
  filing. Two layers: a cheap deterministic collector (python, zero LLM) and an
  LLM gate+distill driven by free in-harness subagents. Use when you want past
  agent conversations turned into durable brain knowledge, or on a cron to keep
  the brain current with what happened across your AI tools. NOT for human
  meeting transcripts (use meeting-ingestion) or external media (media-ingest).
triggers:
  - "ingest my transcripts"
  - "distill my agent conversations"
  - "capture claude code / codex / hermes sessions"
  - "what did I work on across my AI tools"
  - "transcript ingest"
tools:
  - Bash
  - Agent
  - Read
  - Write
mutating: true
---

# Transcript Ingest

Turn the firehose of AI agent conversations into curated brain knowledge.
`raw jsonl (in place) -> collect/dedup -> gate -> distill -> stage -> manual file`.

## Contract

- Capture sessions from all wired sources (Claude Code, Codex, Hermes) with NO
  silent caps: sub-agent sidechains and thin sessions are excluded but counted.
- Dedup is content-hash based and incremental: re-running never reprocesses an
  unchanged session; a grown session re-queues automatically.
- The gate admits ONLY durable, newly-CREATED knowledge — never disposable
  artifacts (dated morning notes, one-off reports) or facts merely injected
  from the brain (novelty floor + durability test).
- Staging lives in `brain/.raw/transcript-ingest/` — git-versioned but excluded
  from gbrain import/embed, so raw working files never enter the brain DB.
- Distilled notes are STAGED only. Filing into the real brain (personal / yei /
  industry, via each RESOLVER) is manual show-and-confirm. The skill never
  auto-writes to the embedded brain.

## Phases

1. **Collect** (cheap, python, cron-safe).
   `python3 lib/collect.py`
   Scans every source glob, excludes sidechains, dedups by sha, drops thin
   sessions (<200 human chars), writes new/grown sessions to `_queue/<key>.txt`
   and refreshes `_manifest.json` (all pending, ranked by human chars).

2. **Distill batch** (LLM, free subagents — Mode A).
   `python3 lib/distill_batch.py [N]` emits a JSON spec of the next N pending
   workers (session_file + gate/distill prompt paths). For each worker, spawn
   ONE in-harness Agent (NOT a paid CLI binary) running `prompts/distill_prompt.md`.
   Each worker gates, then writes a distilled note to `_distilled/<domain>/<key>.md`
   if SIGNAL, and returns one report line.

3. **Mark** (cheap, python).
   Pipe all worker report lines to `python3 lib/mark.py` to record verdict +
   domain and flip state to done, so they never re-gate.

4. **Review + file** (manual, show-and-confirm).
   Read `_distilled/<domain>/*.md`. For each keeper, file into the matching
   brain via its RESOLVER (personal `brain/`, yei work-vault/yei-brain, industry
   `industry-db/`). Verify any second-hand number/address/ticker against source
   before promoting it to an entity-page fact. Then delete or archive the staged note.

## Output Format

- `brain/.raw/transcript-ingest/_queue/<key>.txt` — normalized pending sessions
- `brain/.raw/transcript-ingest/_distilled/<domain>/<key>.md` — staged notes
- `brain/.raw/transcript-ingest/state.json` — dedup + verdict ledger
- `_manifest.json` — pending work list, ranked
- Per-worker report line: `<key> | SIGNAL|NOISE | <domain> | <path|-> | <why>`

## Anti-Patterns

- Auto-filing distilled notes into the embedded brain. Staging is mandatory;
  filing is manual.
- Promoting a second-hand number/address/ticker from a transcript into an entity
  page without grepping the source. Assistants fabricate mid-session.
- Admitting disposable artifacts (today's morning note, a weekly report) as
  signal just because they contain entity names — they fail the durability test.
- Counting injected brain context as new signal — it was consumed, not created.
- Ingesting sub-agent sidechains as standalone sessions — they fragment the
  parent's signal.
- Dispatching distill via a paid CLI binary instead of free in-harness subagents.

## Tools Used

- `lib/collect.py` — deterministic scan/dedup/normalize/queue (no LLM)
- `lib/distill_batch.py` — emit next-N worker dispatch specs (no LLM)
- `lib/mark.py` — write verdicts back to state (no LLM)
- `lib/normalize.py` — 3-source jsonl schema unifier
- `prompts/gate_prompt.md` — signal/noise + domain + novelty + durability
- `prompts/distill_prompt.md` — per-session gate+distill worker
- Agent (in-harness subagents) for gate + distill
- `gbrain put_page` / `capture` only at the manual filing step

## Not Yet Wired

- ChatGPT + Typeless sources (no local jsonl; need export/API into the queue).
- Distilled -> brain filing is manual by design (could add an assisted filer later).
