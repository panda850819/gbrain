---
name: citation-fixer
version: 1.2.1
description: |
  Audit and fix citation formatting across brain pages. Ensures every fact has
  an inline [Source: ...] citation matching the standard format. Extended in
  v0.25.1: scans for broken tweet/post references that lack actual URLs and
  resolves them via the host's X / Twitter API integration. v1.2.0: Phase 1-2
  (scan + identify) dispatched to subagent for cost cut. v1.2.1: production-run
  caveat — Sonnet not Haiku, 10-page batches, sequential not parallel, retry on
  format drift. Empirical: 20-page Haiku batches drift to prose ~60% of runs;
  5-parallel dispatch triggers "prompt too long" rejections on later batches.
triggers:
  - "fix citations"
  - "fix broken citations"
  - "citation audit"
  - "check citations"
  - "citation fixer"
tools:
  - search
  - get_page
  - put_page
  - list_pages
mutating: true
---

# Citation Fixer Skill

> **Convention:** see [conventions/quality.md](../conventions/quality.md) for
> the canonical citation format every fix should match.
>
> **Output rule:** all links MUST be deterministic (built from API data,
> not composed by LLM). See [_output-rules.md](../_output-rules.md).

## Contract

This skill guarantees:

- Every brain page is scanned for citation compliance.
- Missing citations are flagged with specific location.
- Malformed citations are fixed to match the standard format.
- **(v0.25.1)** Tweet / post references without URLs are resolved via
  X API and patched with deterministic `https://x.com/<handle>/status/<id>`
  links.
- Results reported with counts (scanned, fixed, remaining).

## Execution dispatch (v1.2.1)

Phases 1 (scan) and 2 (identify issues) are **pure structural detection** —
regex + format spec comparison, no voice judgment, no cross-page synthesis.
These phases SHOULD be dispatched to a **Sonnet 4.6** subagent via the Agent
tool when scanning >20 pages, to cut audit cost ~70-80%.

| Phase | Model | Why |
|---|---|---|
| 1 Scan pages | **Sonnet** subagent | Pure file read + regex; reliable JSON-strict output |
| 2 Identify issues | **Sonnet** subagent (same batch) | Spec comparison; structured output stable at scale |
| 3 Fix format | **Opus** main | Rewriting needs context judgment |
| 4 Resolve tweets | **Opus** main | X API + entity matching + judgment |
| 5 Report | **Bash** or main | Pure aggregation |

### Why Sonnet, not Haiku (v1.2.1 production-run finding)

Empirical 100-page run (2026-05-26):

| Issue | Observed rate | Root cause |
|---|---|---|
| JSON-strict output drift to prose | ~60% on 20-page batches | Haiku 4.5 instruction-following degrades past ~10-page workload |
| Hallucinated meta-narrative (Haiku invents "previous subagent violated TEXT-ONLY") | 1/5 batches | Haiku confuses parallel-dispatch context |
| "Prompt is too long" rejections | 2/5 parallel batches | 5-way fan-out from one main message exceeds aggregate context budget |

**Net:** only 20% of 5-parallel Haiku batches returned actionable JSON. Cost
savings vanish when 80% of dispatches are unusable.

**Sonnet 4.6 holds JSON-strict output at 20-page batches**, costs ~3x Haiku
but ~10x cheaper than Opus, and parallel fan-out doesn't trigger the
context-budget gate at 2 concurrent batches. Net saving still 70-80% vs all-Opus.

### Dispatch pattern (Phases 1-2)

For each batch of **10 brain pages** (NOT 20), the orchestrator (main Opus
session) calls **sequentially or 2-parallel max**:

```
Agent({
  description: "Citation audit batch N",
  subagent_type: "Explore",          # read-only is enough
  model: "sonnet",                    # NOT haiku for batches >5 pages
  prompt: """
    Audit these N pages for citation format issues. Spec: every fact must have
    an inline `[Source: ...]` citation matching one of these shapes:

      - User statement: [Source: User, {context}, YYYY-MM-DD]
      - Web: [Source: {publication}, {URL}, YYYY-MM-DD]
      - Social: [Source: X/@handle, YYYY-MM-DD](URL)
      - Synthesis: [Source: compiled from {sources}]
      - (full spec at ~/gbrain/skills/conventions/quality.md)

    Pages:
      - path1
      - path2
      ...

    For each page return JSON. Top 5 issues per page maximum.
    Output ONE JSON object only, no prose, no preamble:

      {
        "audit": [
          { "path": "...", "line_count": N,
            "issues": [
              { "line": 42, "type": "missing_date|missing_url|wrong_format|no_citation",
                "snippet": "<= 60 chars" } ] } ],
        "summary": { "pages_scanned": N, "total_issues": N,
                     "by_type": { "no_citation": N, "missing_date": N,
                                  "missing_url": N, "wrong_format": N } }
      }

    Rules:
      - Do NOT fix; detect only.
      - Skip frontmatter, headings, bullet list scaffolds, Timeline /
        Cross-references sections, "待補"/"TBD"/"TODO" markers.
      - JSON only. No prose. No analysis section. No <summary> tags.
  """
})
```

### Retry / fallback protocol

If subagent output is not parseable JSON:

1. **First failure** → re-dispatch same batch with stricter prompt addendum:
   "Your previous response contained prose. Output ONLY the JSON object,
    nothing before or after. Begin response with `{` and end with `}`."
2. **Second failure** → bump to Opus for that batch (cost-trade vs unblock).
3. **Log the failure** in the run report so Sonnet vs Opus split can be
   monitored over time.

### Sequencing rules

- **Maximum 2 parallel subagents** at any time. Higher fan-out triggers
  "Prompt is too long" rejections on later batches.
- **Batch size: 10 pages** (not 20). Smaller batches improve JSON-strict
  output reliability and bound the retry cost.
- **Total throughput**: ~100 pages = 10 batches × 10 pages, dispatched
  in 5 waves of 2-parallel = ~5-10 min wall clock.

### When NOT to dispatch

- Single-page manual fix request ("fix citations on this page")
- < 20 pages to scan total — subagent startup overhead > Sonnet savings
- Tweet resolution (Phase 4) — needs X API state + judgment, keep on Opus

### When Haiku IS OK

- ≤ 5 pages per batch
- Single-batch ad-hoc audit (no parallel dispatch)
- Format-only check (no semantic judgment about whether a claim is a "fact")

## Phases

1. **Scan pages.** List pages and read each one, checking for inline
   `[Source: ...]` citations.
2. **Identify issues:**
   - Facts without any citation
   - Citations missing date
   - Citations missing source type
   - Citations with wrong format
   - **(v0.25.1)** Tweet references without `x.com` URLs
3. **Fix format issues.** Rewrite malformed citations to match
   `conventions/quality.md`.
4. **(v0.25.1) Resolve tweet references** via the X API integration.
5. **Report results.** Count: pages scanned, citations found, issues
   fixed, tweets resolved, remaining gaps.

## Tweet resolution pipeline (v0.25.1 extension)

For each broken tweet reference, follow this chain. The actual API call
goes through whatever X integration the host has configured (typical
shape: a recipe under `recipes/x-api/` with handle / search-all
endpoints).

### Step 1: Identify broken references

Scan the page for patterns that indicate tweet references without URLs:

- Contains words like `tweeted`, `posted`, `said on X`, `RT`, `retweet`,
  `X post`
- Contains quoted text that looks like a tweet (short, punchy, often
  starts with a quote)
- Has `[Source: ... X/Twitter ...]` without an `x.com` URL
- References engagement metrics (likes, impressions) without a link

### Step 2: Extract searchable content

From each broken reference, extract:

- The **handle** (if mentioned: `@<username>`)
- The **quoted text** (if available)
- The **approximate date** (often present in surrounding timeline entries)

### Step 3: Search for the actual tweet

Use the host's X API integration. Query patterns:

```
# Handle + quoted text:
from:<handle> "<exact quote fragment>"

# Quoted text only:
"<exact quote fragment>"

# Original of a retweet:
"<exact quote>" -is:retweet
```

### Step 4: Verify and extract metadata

Once a candidate is found:

- Confirm the text matches the quoted fragment.
- Pull the tweet id, author handle, engagement metrics (likes / RTs /
  impressions).
- Construct the URL: `https://x.com/<handle>/status/<tweet_id>`.

### Step 5: Patch the brain page

Replace the broken citation with a proper one:

**Before:**

```
"<quote fragment>" [Source: <some hand-wavy attribution>]
```

**After:**

```
"<full verified quote>" — <N> likes, <N> RTs, <N> impressions
[Source: [X/<handle>, YYYY-MM-DD](https://x.com/<handle>/status/<tweet_id>)]
```

## Batch mode

When sweeping many pages:

### Find candidate pages

```bash
# Pages mentioning tweets but with no x.com links
for f in $(find . -name "*.md" -not -path "./node_modules/*"); do
  refs=$(grep -ci "tweet\|posted\|x post\|RT\|retweet\|said on X" "$f")
  links=$(grep -c "x.com/.*/status/" "$f")
  if [ "$refs" -gt 2 ] && [ "$links" -eq 0 ]; then
    echo "$f"
  fi
done
```

### Priority order

1. Recently created / updated pages — fresh broken refs are easiest to
   resolve while context is fresh.
2. High-traffic pages (frequent reads / writes from other skills).
3. Everything else — bulk cleanup over time.

### Rate limiting

- X API: respect the host's tier limits; don't hammer.
- Target ~50 pages per batch run.
- 1-3 API calls per page (search + verify).
- Batch-commit every 10-20 pages so a partial failure doesn't lose
  progress.

## Output format

```
Citation Audit Report
=====================
Pages scanned:        N
Citations found:      N
Issues fixed:         N
Tweet links resolved: N
Remaining gaps:       N (pages with uncitable facts)
```

## Anti-Patterns

- ❌ Inventing citations for facts that have no source. Flag them.
- ❌ Removing facts that lack citations (flag them; don't delete).
- ❌ Fixing citations without reading the full page context.
- ❌ Batch-fixing without checking quality on a sample first
  (see `conventions/test-before-bulk.md`).
- ❌ Composing tweet URLs by guessing the tweet id. Always go through
  the X API; deterministic links only.

## Integration

This skill can be called:

- **Manually** — "fix citations on this page"
- **As a batch cron** — weekly sweep of pages with broken refs
- **By other skills** — `enrich` or `media-ingest` can call citation-fixer
  before commit to validate output

## Metrics

If running as a recurring batch, track state in a small JSON file under
`~/.gbrain/citation-fixer-state.json`:

```json
{
  "last_run": "2026-04-15T...",
  "pages_scanned": 0,
  "citations_fixed": 0,
  "tweet_links_resolved": 0,
  "citations_unresolvable": 0,
  "pages_remaining": 1424
}
```


## Output Format

The skill's output shape is documented inline in the body sections above (see "Output", "Brain page format", or equivalent). The literal section header here exists for the conformance test (`test/skills-conformance.test.ts`).
