---
name: brain-ops
version: 1.0.0
description: |
  Brain knowledge base operations. The core read/write cycle: brain-first lookup,
  read-enrich-write loop, source attribution, ambient enrichment, back-linking.
  Read this before any brain interaction.
triggers:
  - any brain read/write/lookup/citation
tools:
  - search
  - query
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
  - get_backlinks
  - sync_brain
mutating: true
writes_pages: true
writes_to:
  - people/
  - companies/
  - deals/
  - concepts/
  - meetings/
---

# Brain Operations — The Ambient Context Layer

The brain is not an archive. It is a live context membrane that every interaction
flows through in both directions.

> **Convention:** See `skills/conventions/brain-first.md` for the 5-step lookup protocol.
> **Convention:** See `skills/conventions/quality.md` for citation and back-link rules.

## Contract

This skill guarantees:
- Brain is checked BEFORE any external API call (brain-first lookup)
- Every inbound signal triggers the READ → ENRICH → WRITE loop
- Every outbound response checks brain for relevant context
- Source attribution on every fact written (inline `[Source: ...]` citations)
- User's direct statements are highest-authority data
- Back-links maintained on every brain write (Iron Law)

## Iron Law: Back-Linking (MANDATORY)

Every mention of a person or company with a brain page MUST create a back-link
FROM that entity's page TO the page mentioning them. An unlinked mention is a
broken brain. See `skills/conventions/quality.md` for format.

## Phases

### Phase 1: Brain-First Lookup (MANDATORY)

Before using ANY external API to research a person, company, or topic:

1. `gbrain search "name"` — keyword search for existing pages
2. `gbrain query "natural question about name"` — hybrid search for context
3. `gbrain get <slug>` — if you know the slug, read the full page
4. Check backlinks: who references this entity?
5. Check timeline: recent events involving this entity

The brain almost always has something. External APIs fill gaps, not start from scratch.

### Phase 2: On Every Inbound Signal (READ → ENRICH → WRITE)

Every message, meeting, email, or conversation that references a person or company:

1. **Detect entities** — people, companies, deals mentioned
2. **Load brain pages** — read existing pages for context before responding
3. **Identify new information** — what does this signal tell us that the page doesn't know?
4. **Write it back** — update the brain page with new info + timeline entry + source citation
5. **Create if missing** — if notable and no page exists, create via enrich skill

**User's direct statements are the highest-value data source.** Write them to brain
pages immediately with attribution `[Source: User, YYYY-MM-DD]`.

### Phase 2.5: Structured Graph Updates (automatic)

Every `put_page` call automatically extracts entity references and writes them
to the graph (`links` table) with inferred relationship types. Stale links
(refs no longer in the page text) are removed in the same call. This is
"auto-link" reconciliation.

#### CLI `gbrain put` pitfall

`gbrain put <slug>` expects a slug, not a markdown filepath. If you pass
`reports/foo.md` as the slug without `--content`, write-through can create a
stub duplicate like `reports/foo.md.md`. When indexing an edited local file,
strip the `.md` extension from the slug and pass the file body explicitly:

```bash
python3 - <<'PY'
import pathlib, subprocess
path = pathlib.Path('reports/foo.md')
slug = str(path.with_suffix(''))
subprocess.run(['gbrain', 'put', slug, '--content', path.read_text()], check=True)
PY
```

If a `.md.md` duplicate is accidentally created, verify it is a stub, move it
to Trash rather than deleting permanently, then rerun `gbrain put` with the
correct slug + `--content` form.

- No manual `add_link` calls needed for ordinary page writes.
- Inferred link types: `attended` (meeting -> person), `works_at`, `invested_in`,
  `founded`, `advises`, `source` (frontmatter), `mentions` (default).
- The `put_page` MCP response includes `auto_links: { created, removed, errors }`
  so the agent can verify outcomes.
- To disable: `gbrain config set auto_link false`. Default is on.
- Timeline entries with specific dates still need explicit `gbrain timeline-add`
  (or batch via `gbrain extract timeline --source db`).

#### Maintenance and tooling repairs

For brain health repair passes, fix the layer that owns the problem:

- Valid template / resolver / README examples should not be rewritten to appease lint. If `placeholder-date` or `code-fence-wrap` reports valid examples, narrow the lint rule and add regression tests.
- If `gbrain extract * --source db` logs Postgres `malformed array literal` for link/timeline batches, suspect array-parameter handling of free-form markdown contexts before blaming the content. Prefer bounded parameterized `VALUES` batches over `unnest($1::text[])` for markdown-heavy fields.
- Treat high stale-page counts dominated by `people/` and `companies/` as an entity synthesis queue. Cluster by prefix/type/timeline density first; do not bulk rewrite low-signal entity pages just to reduce the metric.

See `references/gbrain-maintenance-debugging.md` for the concrete debugging patterns and verification commands.

### Phase 3: On Every Outbound Response (READ → PULL → RESPOND)

Before answering any question about a person, company, or topic:

1. **Check the brain** — read relevant pages
2. **Pull context** — use compiled truth + recent timeline
3. **Respond with context** — the brain makes every answer better

Don't answer from general knowledge when a brain page exists.

#### Expanding Brain Dream / cron summaries

When the user asks to "expand", "展開來說", or explain a Brain Dream / cron output:

1. Read the cron output artifact if a job id or output path is visible.
2. Search/read the brain pages named or implied by the summary, especially `reflections/dreams/*`, `learnings/*`, `inbox/*`, and the original EOD/session source.
3. Separate three layers in the response: raw user/source signal, Dream synthesis, and operational consequence.
4. Preserve open decisions explicitly. Do not auto-resolve content authenticity choices, citation deletion, or irreversible brain cleanups unless the user asked for the action.
5. Keep the answer as an analyzed expansion, not a task log. Mention paths only when they help the user inspect or continue the thread.

### Phase 4: Ambient Enrichment

This is not a special mode. This is the default. Everything the user says is an
ingest event.

- Person mentioned → check brain, create/enrich if needed (spawn background)
- Company mentioned → same
- Link shared → ingest it (delegate to idea-ingest)
- Data shared → delegate to appropriate skill

**Rules:**
- Never interrupt the conversation to do enrichment
- Spawn sub-agents for anything that would slow down the response
- Never announce "I'm enriching the brain" — just do it silently

### Source-Intake Judgment Ledger

Deterministic cron scripts that produce domain-specific data (health, market) should
write per-run judgment entries to the source-intake ledger. See
`references/source-intake-script-pattern.md` for the helper template, field shape,
and concrete examples. The ledger lives at `.raw/source-intake/judgment-ledger.jsonl`
and feeds into the weekly EVO review.

## Output Format

No separate output. Brain-ops is an always-on behavior layer, not a report generator.
The output is updated brain pages and enriched responses.

## Cross-source citation format (v0.18.0+)

When a brain has multiple sources (wiki, gstack, yc-media, etc.), every
citation MUST include the source id: `[source-id:slug]`. Example:

> You told me about the retry budget approach — see
> [wiki:topics/resilience] and [gstack:plans/retry-policy] for where
> this came from.

Rules:
- The key is `sources.id` (immutable), never `sources.name` (mutable display).
- Single-source brains still write `[default:slug]` OR may omit the prefix
  for backward compat.
- Every page payload returned by `search`, `query`, `get_page`, `list_pages`
  carries `source_id` — always use it when citing, never guess.

If a search result has `source_id: "gstack"` and `slug: "plans/foo"`,
the citation is `[gstack:plans/foo]`. That's the whole rule.

## Anti-Patterns

- Answering questions about people/companies without checking the brain first
- Using external APIs before checking the brain
- Writing facts without inline `[Source: ...]` citations
- Blocking the response to do enrichment
- Overwriting user's direct statements with lower-authority sources
- Creating brain pages for non-notable entities

## Tools Used

- `search` — keyword search
- `query` — hybrid vector+keyword search
- `get_page` — read a brain page
- `put_page` — create/update brain pages
- `add_link` — cross-reference entities
- `add_timeline_entry` — record events
- `get_backlinks` — check who references an entity
- `sync_brain` — sync changes to the index
