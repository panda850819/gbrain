---
name: idea-ingest
version: 1.0.0
description: |
  Ingest links, articles, tweets, and ideas into the brain. Fetch content, save
  to brain with analysis, create author people page, and cross-link. Use when the
  user shares a link or says "read this", "save this", "think about this".
triggers:
  - shares a link or URL
  - "read this"
  - "save this"
  - "think about this"
  - "put this in brain"
tools:
  - search
  - query
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
  - file_upload
mutating: true
writes_pages: true
writes_to:
  - people/
  - concepts/
  - sources/
---

# Idea Ingest Skill

> **Filing rule:** Read `skills/_brain-filing-rules.md` before creating any new page.

## Contract

This skill guarantees:
- Every ingested item has a brain page with genuine analysis (not just a summary)
- The author gets a people page (MANDATORY for anyone whose thinking is worth ingesting)
- Cross-links created bidirectionally (source ↔ author, source ↔ mentioned entities)
- Raw source preserved for provenance via `gbrain files upload-raw`
- Every fact has an inline `[Source: ...]` citation
- Filing follows primary subject rules (not format-based)

> **Convention:** See `skills/conventions/quality.md` for Iron Law back-linking.

Every mention of a person or company with a brain page MUST create a back-link.
Format: `- **YYYY-MM-DD** | Referenced in [page title](path) — brief context`

## Phases

1. **Fetch the content.** Use appropriate tools for the content type (web fetch for articles, API for tweets, PDF reader for documents).

2. **Upload raw source.** Save the fetched content for provenance: `gbrain files upload-raw <file> --page <slug>`

3. **Identify the author — MANDATORY people page.** Anyone whose thinking is worth ingesting is worth tracking.
   - Search brain for existing author page
   - If no page → CREATE ONE with compiled truth + timeline format
   - If page exists → update timeline with this new publication
   - Cross-link both directions

4. **Save to brain.** File by PRIMARY SUBJECT (read `skills/_brain-filing-rules.md`):
   - About a person → `people/`
   - About a company → `companies/`
   - A reusable framework → `concepts/`
   - Raw data dump → `sources/`

5. **Analyze for the user.** Reply with analysis that connects the content to what the brain knows. Think about:
   - Active projects — is this relevant?
   - Contradictions — does this challenge existing brain knowledge?
   - Connections — does this involve known people/companies?
   - Don't just summarize. Tell the user things they wouldn't have noticed.

6. **Sync.** `gbrain sync` to update the index.

## Output Format

```markdown
# {Title} — {Author}

**Source:** {URL}
**Author:** {Author}, {role}
**Published:** {date}
**Ingested:** {date}

## Context
{Why this matters now, connected to brain knowledge}

## Summary
{3-5 bullet core arguments}

## Key Data / Claims
{Specific facts, numbers, quotes}

## Analysis
{How this connects to existing brain knowledge. What's new. What contradicts.}
```

## Social Link Extraction Fallbacks

For Threads and other JS-heavy social pages, generic extractors may return only the site shell or a truncated `og:description`. If `summarize --extract-only` is empty or clearly incomplete:

1. Open the URL in browser automation.
2. Inspect `document.title`, `og:description`, `twitter:description`, and `document.body.innerText`.
3. Prefer `document.body.innerText` when it contains the visible thread, replies, and author clarifications.
4. Capture notable replies that define scope, boundary conditions, pricing/model usage, or corrections, not only the main post.
5. Preserve the cleaned raw text in a `.raw/` sidecar or via `gbrain files upload-raw` when available.

## Verification Notes

After writing new brain markdown files directly to the repo, `gbrain sync --no-pull --no-embed` may report "Already up to date" without importing the new page into the queryable store. Verify with `gbrain get <slug>` or `gbrain query <distinctive phrase>`. If the page is not found, run:

```bash
gbrain import /path/to/brain --no-embed
```

Then re-run `gbrain get <slug>` for every created page before reporting success.

## Second-Hand Compile Detection

If the content being ingested compiles / summarizes / consolidates other sources (rather than first-hand author voice), preserve the **first-hand source URL list** in frontmatter so future readers can verify original wording without re-fetching the compile page.

**Detect compile nature** (any of):
- Front matter language: "本篇參考 / 整理自 / compile from / based on / N 場訪談精華"
- Body contains embedded `<iframe>` videos or multiple labeled "Source 1, Source 2" markers
- Title pattern: "X 在 Y 領域的實戰心法 / Y 訪談精華 / N 場 podcast 整理"

**When compile detected**:

1. Extract embedded sources via browser automation (cover multiple platforms, not only YouTube):
   ```javascript
   Array.from(document.querySelectorAll('iframe')).map(f => f.src)
   Array.from(document.querySelectorAll('a[href*="youtube"],a[href*="vimeo"],a[href*="spotify"],a[href*="podcast"],a[href*="soundcloud"]')).map(a => a.href)
   ```
2. Resolve embed URL → canonical watch/listen URL **per platform**:
   - YouTube: `youtube-nocookie.com/embed/{id}` → `youtube.com/watch?v={id}`
   - Vimeo / Spotify / Apple Podcasts / SoundCloud / native HTML5: each platform's canonical form
   - Strip embed-only query params; keep only canonical identifiers
3. Add structured frontmatter (schema is generic, not YouTube-specific):
   ```yaml
   source_videos:
     - title: "..."
       publisher: "..."
       url: "https://www.youtube.com/watch?v=..."
       transcribed: false
   source_articles:    # if compile cites articles
     - title: "..."
       author: "..."
       url: "..."
       ingested_to_brain: false
   ```
4. Body `## Source` section splits into two: **第二手 compile (本文 ingest 對象)** + **第一手 source list (表格式)** + **Transcription policy** (default 不做，列觸發條件).
5. Default `transcribed: false` — flip true only after `media-ingest` skill processes the specific source.

Trigger to actually transcribe a first-hand source:
- Verifying whether a quoted framing is original wording or compile interpretation
- Capturing speaker cadence / improvised examples lost in compile
- Anchoring a public-facing citation (blog / brief) to original
- Source is referenced 3+ times across brain (warrants 1 transcription)

Skip transcription otherwise. The URL list itself is cheap; transcribing is expensive (8-12 hr per 4-podcast set).

See: [[learnings/patterns/2026-05-24-secondhand-compile-preserves-firsthand-source-urls]] for full rationale.

## Scope-Discipline Self-Check

Personalized analysis sections (`## Why it matters` / `## Analysis` / `## Actionable`) must pass a self-check before being saved:

For each section that draws a parallel / comparison / actionable to user context:

1. What scope assumption does this paragraph make? (Personal vs. company-ops vs. portfolio-VC vs. founder-side, etc.)
2. Does an earlier paragraph (or the article's source itself) contain a scope disclaimer that **excludes** the current paragraph's frame?
3. If yes → **delete the paragraph** or rewrite it as generic mechanism. Do **not** keep "這不代表 X 錯。它代表 [continues doing X]" style hedged transitions. Those are force-fit tells.

Greppable anti-pattern phrasings (signals you wrote disclaimer then violated it):

- 「這不代表 X 錯。它代表 [緊接著做 X 不該做的事]」
- 「儘管場景不對稱，但 [接著對比]」
- 「雖然 [scope A] 跟 [scope B] 不同，但我們仍然可以 [跨 scope 對照]」
- 「在 [future retro] 時拿出來對照 [跨 scope frame]」

Also: reference-library entries (`media/articles/`, `media/books/`, `topics/`) stay **generic / portable**. Application binding ("在 Yei 第 X 條提案用 / 在 Sommet Q3 用") belongs in `briefs/{specific-brief}.md` or `projects/{project}.md`, not the reference entry. Reference end never main-writes a site link — binding end links back, brain auto-backlink populates reference's Timeline section.

See:
- [[learnings/pitfalls/2026-05-24-disclaimer-without-self-check-during-personalization]]
- [[learnings/patterns/2026-05-24-reference-library-stays-generic-application-binds-at-site]]

## Anti-Patterns

- Just summarizing without connecting to brain knowledge
- Filing everything in `sources/` (sources is for raw data dumps only)
- Skipping the author people page
- Not cross-linking to mentioned entities
- Ingesting without checking brain first for existing coverage
- Trusting extractor output for JS-heavy social pages without checking browser-visible text
- Reporting a brain ingest as done before `gbrain get <slug>` succeeds for the created page
- **Ingesting a second-hand compile (X summarizes Y) without preserving first-hand source URLs in frontmatter** — future verification of original wording becomes impossible without re-fetching
- **Writing scope disclaimer in one paragraph then doing force-fit comparison in the next** — anti-pattern transitions ("這不代表 X 錯，但..." / "儘管場景不對稱，但...") are tells; rewrite as generic or delete
- **Hard-linking generic reference entries to current employer / project** — `media/articles/` entries should stay portable; application binding lives in `briefs/{specific}.md`
