---
name: book-mirror
version: 0.2.0
description: |
  Take any book (EPUB/PDF) and produce a personalized chapter-by-chapter analysis in two-column tables: left preserves chapter content, right maps each idea to the reader's life using brain context. Output: media/books/<slug>-personalized.md plus optional PDF. Dual mode: agent-orchestrated (free) or headless CLI (paid) for cron.
triggers:
  - "personalized version of this book"
  - "mirror this book"
  - "two-column book analysis"
  - "apply this book to my life"
  - "how does this book apply to me"
mutating: true
writes_pages: true
writes_to:
  - media/books/
---

# book-mirror — Personalized Chapter-by-Chapter Book Analysis

> **Convention:** see [_brain-filing-rules.md](../_brain-filing-rules.md) for the
> sanctioned `media/<format>/<slug>` exception this skill files under.
>
> **Convention:** see [conventions/quality.md](../conventions/quality.md) for
> citation rules, back-link enforcement, and output quality bars.
>
> **Convention:** see [conventions/brain-first.md](../conventions/brain-first.md)
> for the lookup chain (brain → search → external) the context-gathering
> phase follows.

## What this does

Given a book (EPUB or PDF), produce a brain page where every chapter is
summarized in detail on the left and mirrored back to the reader's actual life
on the right, using their own words, situations, people, and patterns from
the brain. Output is a brain page at `media/books/<slug>-personalized.md`.

This is NOT a generic book summary. The right column is the value: it makes
the book read like a therapist who knows the reader is leaving notes in the
margins. If the user wants a flat summary instead, route them to a different
skill.

## Execution modes (pick one before step 4)

The expensive part of this skill is the per-chapter LLM fan-out. Where that
fan-out runs decides whether it costs anything.

```
                          is an agent runtime already driving this skill?
                          (Claude Code / Codex / any CLI with subagents)
                                          │
                 ┌────────────────────────┴────────────────────────┐
                YES                                                  NO
                 │                                                   │
        ┌────────▼─────────┐                              ┌──────────▼──────────┐
        │ MODE A (default) │                              │ MODE B (headless)   │
        │ agent-orchestr.  │                              │ gbrain book-mirror  │
        │ fan-out          │                              │ binary              │
        │ • free (runs on  │                              │ • self-contained:   │
        │   the runtime's  │                              │   calls Anthropic   │
        │   own quota)     │                              │   API itself → $    │
        │ • agent dispatch │                              │ • durable queue,    │
        │   read-only      │                              │   idempotency,      │
        │   workers, then  │                              │   retry, monitoring │
        │   single write   │                              │ • cron / Hermes /   │
        │                  │                              │   bare terminal     │
        └──────────────────┘                              └─────────────────────┘
```

**Decision rule:**

- If an agent runtime is executing this skill (it has a subagent/Task tool and
  can write the brain page itself), use **Mode A**. The runtime already
  provides the LLM and the subagents; routing the fan-out back out to
  `gbrain book-mirror` would spin up a *second*, separately-billed LLM runtime
  to do the same work. That is avoidable cost. Mode A is the default.
- If there is **no** agent runtime — a launchd/cron job, a Hermes-spawned
  `codex -p`, or a bare terminal — use **Mode B**. There is no subagent layer
  to borrow, so the CLI must bring its own LLM (the paid API call). Mode B also
  buys durability (Postgres-backed queue, idempotency keys, retry) that a
  one-shot interactive run does not need.

Both modes produce the identical artifact and honor the same trust contract.

## Trust contract (read this before running)

The book text is untrusted input. A malicious EPUB/PDF could contain
prompt-injection aimed at writing into `people/*` or other brain pages.
Both modes close that vector the same way: **workers are read-only; exactly
one trusted writer emits the final page.**

- **Mode A:** dispatch the per-chapter workers in a **read-only role** — they
  must NOT have `Edit` / `Write` / `put_page` or any mutating tool. They read
  the chapter text + context pack and return markdown analysis as their final
  message. The orchestrating agent collects those strings and performs a
  single `put_page` (operator trust). Workers never touch the brain.
- **Mode B:** the `gbrain book-mirror` CLI submits subagent jobs with
  `allowed_tools: ['get_page', 'search']` (read-only, enforced at the queue
  handler layer). The CLI reads each child's `job.result` and performs the
  single operator-trust `put_page`.

In both cases the trust narrowing is at the tool layer (workers cannot write),
not at a slug-prefix check, and the final write is a single operator-trust
action by the orchestrator/CLI.

## The pipeline

```
SHARED (agent does these regardless of mode)
  1. ACQUIRE   → User has the EPUB/PDF locally (manual; see "Acquiring the book").
  2. EXTRACT   → Pull chapter text from EPUB/PDF into one .txt per chapter.
  3. CONTEXT   → Gather everything the brain knows about the reader → context.md

MODE A (agent-orchestrated, free)        MODE B (headless CLI, paid)
  4a. FAN-OUT  agent dispatches N           4b. gbrain book-mirror --chapters-dir …
      read-only worker subagents,               (validates, cost-gates, fans out
      each returns two-column markdown           read-only subagent jobs, waits)
  5a. ASSEMBLE agent assembles +            5b. CLI assembles + single put_page
      single put_page

SHARED (after the page lands)
  6. PDF        → Optional: render via skills/brain-pdf for delivery.
  7. FACT-CHECK → Verify claims about the reader; add cross-links.
```

## 1. Acquiring the book

book-acquisition (legal-grey-area downloader) was deliberately not shipped
in this skill wave. The user drops the EPUB/PDF manually. Common paths the
user might use:

```bash
# User-supplied path
ls path/to/book.epub
ls path/to/book.pdf

# Or already in the brain repo (recommended for tracking)
ls $BRAIN_DIR/media/books/
```

Resolve `$BRAIN_DIR` from the gbrain config (`gbrain config get sync.repo_path`)
or accept it from the user.

## 2. Text extraction

Goal: one `.txt` file per chapter under a temp directory. The agent has
shell + python access. Both modes consume the same `chapters/` directory.

### EPUB

Some readers (e.g. iBooks) store an `.epub` **unpacked as a directory**, not a
zip. Handle both, and split by the table of contents (`toc.ncx` / nav) using
the spine order — naive "one file per xhtml" mis-splits books that put the
chapter title and body in separate files.

```bash
SLUG="this-book"                                # kebab-case
WORK="$(mktemp -d)/$SLUG"
mkdir -p "$WORK/chapters"

SRC="path/to/book.epub"
if [ -f "$SRC" ]; then
  unzip -o "$SRC" -d "$WORK/unpacked"; ROOT="$WORK/unpacked"
else
  ROOT="$SRC"                                   # already an unpacked dir
fi
```

```python
# Split by TOC + spine, concatenating the spine files between consecutive
# chapter entries. Robust to title/body-in-separate-files layouts.
import os, re, sys
from xml.etree import ElementTree as ET
from bs4 import BeautifulSoup

root = os.environ.get("ROOT"); work = os.environ["WORK"]
def find(name):
    for d,_,fs in os.walk(root):
        if name in fs: return os.path.join(d, name)
def clean(s):
    s = re.sub(r'xmlns(:\w+)?="[^"]+"', '', s)
    s = re.sub(r'<(/?)\w+:', r'<\1', s)
    return re.sub(r'\s\w+:(\w+)=', r' \1=', s)

opf = clean(open(find("content.opf"), encoding="utf-8", errors="replace").read())
o = ET.fromstring(opf); base = os.path.dirname(find("content.opf"))
manifest = {i.get("id"): i.get("href") for i in o.findall(".//manifest/item")}
spine = [manifest[r.get("idref")] for r in o.findall(".//spine/itemref")]
pos = {h:i for i,h in enumerate(spine)}

ncx = clean(open(find("toc.ncx"), encoding="utf-8", errors="replace").read())
nav = []
for np in ET.fromstring(ncx).findall(".//navPoint"):
    t = np.find(".//navLabel/text"); c = np.find(".//content")
    nav.append(((t.text or "").strip(), c.get("src").split("#")[0]))

# Pick the chapter range manually after inspecting nav (skip front/back matter).
# Example: chapters = nav[START:END]
chapters = nav  # <-- edit START:END once you've seen the TOC
def strip(href):
    txt = BeautifulSoup(open(os.path.join(base,href),encoding="utf-8",errors="replace").read(),
                        "html.parser").get_text("\n")
    return "\n".join(l.strip() for l in txt.splitlines() if l.strip())
for i,(title,startf) in enumerate(chapters):
    s = pos.get(startf)
    e = pos.get(chapters[i+1][1]) if i+1 < len(chapters) else len(spine)
    open(f"{work}/chapters/{i:02d}.txt","w").write("\n\n".join(strip(f) for f in spine[s:e]))
```

If `bs4` is missing: `pip3 install beautifulsoup4 lxml`. Inspect the TOC first
(`head` the `.txt` files) to choose the chapter range vs front/back matter.

### PDF

```bash
pdftotext -layout path/to/book.pdf "$WORK/full.txt"
```

Then split by chapter heading (look for "Chapter N", "CHAPTER N", or
all-caps title lines) using `awk` or `python`. If the PDF is a scan with
no embedded text, fall back to OCR via `skills/brain-pdf` or another
vision tool.

### Quality check

For each chapter file:

- Sane length (many books run 2k–8k words/chapter; some have short chapters —
  verify the short ones against the raw source rather than assuming truncation).
- No HTML tags.
- Paragraphs preserved with `\n\n`.

Save a `chapters/INDEX.md` mapping chapter number → title → file → length
for reference.

## 3. Context gathering

This is the most critical step. The right column is only as good as the
context fed to each chapter worker, in BOTH modes.

### What to pull

1. **Templates: USER.md and SOUL.md** if the user maintains them
   (gbrain ships templates at `templates/USER.md` and `templates/SOUL.md`;
   they live in the brain repo when populated). Read full.
2. **Recent daily memory** — last ~14 days of the user's daily notes /
   reflections (filing scheme varies; locate it, don't assume a path).
3. **Topic-relevant brain searches** tuned to the book's themes:
   - `gbrain query "marriage"`, `gbrain query "couples therapy"` for a
     marriage book.
   - `gbrain query "founders"`, `gbrain query "fundraising"` for a
     business book.
   - `gbrain query "shame"`, `gbrain query "anger"` for a psychology book.
4. **Brain pages for relevant entities** — `gbrain query "<name>"` for
   people who will likely come up.
5. **Standing patterns** — anything in the user's reflections or
   originals that's been recurring.

### Assemble a context pack

Write a single dense `context.md`. It is embedded in every chapter worker's
prompt, so it must carry: who the reader is, their *actual quoted words*,
current life state (work / money / relationships), people by name, and a
"themes & cruxes" section mapping the book onto what is live in their life
right now. Flag any sensitive topics with a required tone (e.g. grief).

```bash
CONTEXT="$WORK/context.md"
{
  echo "## Reader profile"        # USER.md / SOUL.md / identity
  echo "## Reader's own words"    # verbatim quotes that map to book themes
  echo "## Current life state"    # work, money, relationships, recent events
  echo "## People by name"        # who should appear in the right column
  echo "## Themes & cruxes"       # book ↔ reader intersections + tone flags
} > "$CONTEXT"
```

Make this dense. It is the single biggest lever on right-column quality.

## 4. Fan-out (mode-specific)

### Mode A — agent-orchestrated (default, free)

The driving agent dispatches read-only worker subagents and collects their
markdown. No `gbrain book-mirror` call, no separate API bill — the work runs
on the agent runtime's own quota.

Guidelines:

- **Read-only workers.** Dispatch each worker in a role that has NO
  `Edit` / `Write` / `put_page` (e.g. a read-only/explore-style subagent).
  This is the trust boundary — see Trust contract above.
- **Batch to bound the worker count.** One worker per chapter is cleanest but
  for large books (50+ chapters) assign a small batch (e.g. 6–8 chapters) per
  worker to keep the fan-out manageable. Run batches in parallel.
- **Self-contained prompts.** Each worker reads `context.md` and its assigned
  chapter `.txt` files directly from disk (give it the paths); it does not
  inherit this conversation. It returns ONLY the markdown section(s) below.
- **Output language follows the reader.** If the context pack is in another
  language, the worker writes the right column (and, for a translated source,
  the left column) in that language. Keep the table structure identical.

Per-chapter worker prompt (give this to each worker, once per chapter):

```
You are analyzing ONE chapter of "<BOOK TITLE>" by <AUTHOR> for the reader.

Read these two files in full before writing:
- Reader context pack:  <abs path>/context.md
- Chapter text:         <abs path>/chapters/<NN>.txt   (this is chapter <N> of <TOTAL>)

Produce a markdown two-column section. LEFT column preserves the chapter's
actual content (stories, frameworks, statistics, named examples — do not
summarize the texture away). RIGHT column maps each idea to the reader's
actual life using their words, dates, people, and situations from the context
pack. Output ONLY this section, no preamble or postscript:

## Chapter <N>: [title from the chapter]

### Key Ideas
[2-4 sentence thesis — what the author is actually arguing.]

| What the Author Says | How This Applies to You |
|---|---|
| [A section/argument from the chapter, preserving stories/stats/frameworks. Use <br><br> for paragraph breaks inside the cell.] | [Specific personal connection: name dates, people, exact quotes from the reader, real situations. Same <br><br> for breaks.] |
| [next section] | [next mirror] |
| [4-10 rows by chapter density] | |

RULES
- LEFT: keep the texture. RIGHT: use the reader's actual words from the context
  pack; name specific people/dates/situations; read like someone who knows them.
- 4-10 rows. If a section honestly doesn't apply, write
  "*This section is less directly relevant because [specific reason].*" — do not
  force connections.
- Never generic ("this might apply if you've ever felt…"), never sycophantic,
  never preachy ("you should…"). Respect any tone flags in the context pack.
- You have read-only tools only. You CANNOT write to the brain. Your output is
  the markdown text in your final message.
```

Collecting worker output — two strategies:

- **Small books:** workers return the markdown as their final message; the
  orchestrator keeps it keyed by chapter index.
- **Large books (many chapters):** to avoid funneling the whole book through
  the orchestrator's context, let each worker write its chapter section(s) to a
  **scratch dir** (e.g. `$WORK/out/<NN>.md`) and return only a one-line "done"
  summary. The orchestrator then concatenates the scratch files in order. The
  scratch dir is NOT the brain — workers still never write a brain page; the
  single operator `put_page` in step 5 remains the only brain mutation, so the
  trust contract holds.

Treat a missing/garbled return (or a missing/empty scratch file) as a failed
chapter and re-dispatch just that chapter.

### Mode B — headless CLI (`gbrain book-mirror`, paid)

For cron / Hermes / bare-terminal runs where no agent runtime is present.

```bash
gbrain book-mirror \
  --chapters-dir "$WORK/chapters" \
  --context-file "$CONTEXT" \
  --slug "$SLUG" \
  --title "Book Title Goes Here" \
  --author "Author Name" \
  --model claude-opus-4-7
```

The CLI validates inputs, prints a cost estimate (~$0.30/chapter at Opus,
~$0.06 at Sonnet) and confirms (TTY) or requires `--yes` (non-TTY), submits N
read-only subagent jobs, waits, assembles, and writes ONE `put_page`. It
reports a JSON envelope:
`{"slug": …, "chapters_total": N, "chapters_completed": N, "chapters_failed": 0}`.
Idempotency keys (`book-mirror:<slug>:ch-<N>`) dedupe completed chapters, so a
re-run only retries failures. Default model `claude-opus-4-7`; Sonnet works but
right-column quality drops noticeably.

## 5. Assemble + write (Mode A)

In Mode B the CLI already wrote the page; skip to step 6. In Mode A the
orchestrating agent assembles and performs the single write.

Build the page as: frontmatter + intro + per-chapter sections (sorted by
index, joined by `\n\n---\n\n`) + a failed-chapters note if any.

```
---
title: "<Title> — Personalized"
type: book-analysis
author: "<Author>"
date: <YYYY-MM-DD>
tags: [book, personalized, two-column]
---

# <Title> — Personalized

## What this is

A chapter-by-chapter personalized analysis of *<Title>* by <Author>. Each
chapter is summarized in detail on the left and mirrored to the reader's actual
life on the right, drawing on brain context. Per-chapter analysis was produced
by read-only worker subagents with no write access; this page is the only
artifact written.

---

<chapter sections, sorted, joined by --->
```

Then perform the single operator-trust write to
`media/books/<slug>-personalized` — via `gbrain put_page` (or the brain's
`put_page` op / MCP). This is the only write the whole skill makes.

## 6. PDF (optional)

After the brain page is written, render to PDF using `skills/brain-pdf`
(see `skills/brain-pdf/SKILL.md` for the make-pdf invocation). The brain page
is the source of truth; the PDF is a rendering.

## 7. Fact-check and cross-link

After the page lands, run a fact-check pass on factual claims about the
reader (parents, siblings, marriage history, jobs, heritage). Common error
patterns to look for:

- Conflating the reader's parents' relationship with patterns in extended
  family.
- Inventing therapy backstory ("after his parents' divorce…") when the
  reader's parents are still together.
- Wrong number/age of children, wrong spouse / kid / sibling names.

If you can't verify a claim, remove it. Better to lose texture than to
introduce a falsehood.

Cross-link entities mentioned in the analysis:

- For every person the right column references with a brain page, add a
  back-link from `people/<slug>` to the new `media/books/<slug>-personalized`
  page (per `conventions/quality.md` Iron Law).

## Quality bar (the bar)

The **left column** should:

- Preserve the author's actual stories, statistics, frameworks, examples.
- Quote memorable phrases verbatim.
- Be detailed enough that the reader could skip the book and not lose much.

The **right column** should:

- Use the reader's *actual quoted words* from the context pack.
- Reference *specific* dates, situations, people by name.
- Read like a therapist who knows the reader is leaving notes in the margins.
- Be plain about direct hits ("This is exactly the [name a real situation]").
- Be honest about misses ("This chapter is less directly relevant
  because…"). Don't force connections.

The **whole document** should feel like one coherent voice, calibrated to
the reader's actual life rather than a generic profile, and honest about
where the book's framing breaks down for this specific reader.

## Anti-patterns (do not do these)

- ❌ **Paying for Mode B inside an agent runtime.** If an agent (with subagents
  + write access) is driving, use Mode A. Calling `gbrain book-mirror` from
  there spins up a second, separately-billed LLM runtime for no benefit.
- ❌ **Giving workers write access.** Trust contract is read-only workers +
  one operator write. Never let a per-chapter worker call `put_page`.
- ❌ **Skimming chapters.** Standing instruction: preserve detail.
- ❌ **Generic right column.** "This might apply if you've ever felt…" →
  kill on sight.
- ❌ **Factual errors about the reader's life.** Always fact-check after
  assembly.
- ❌ **Forcing connections.** If a chapter doesn't apply, say so plainly.
- ❌ **Sycophancy or moralizing in the right column.** No "you should…",
  no "consider…", no "perhaps it's time to…".
- ❌ **Truncating the LEFT column.** The book's actual content needs to
  survive.

## Output checklist

- [ ] Book file exists locally (path known).
- [ ] Chapter texts under `$WORK/chapters/*.txt` with sane lengths.
- [ ] Context pack at `$WORK/context.md` is dense.
- [ ] Execution mode chosen (A: agent-orchestrated / B: `gbrain book-mirror`).
- [ ] Mode A: workers were read-only; all chapters returned; agent did one write.
- [ ] Mode B: `gbrain book-mirror …` returned exit 0.
- [ ] `media/books/<slug>-personalized.md` exists in the brain.
- [ ] Fact-check pass complete (no errors against USER.md or other source-of-truth pages).
- [ ] Cross-links added from referenced people/companies.
- [ ] Optional: PDF rendered via brain-pdf and delivered.

## Related skills

- `skills/brain-pdf/SKILL.md` — render the personalized page to PDF.
- `skills/strategic-reading/SKILL.md` — read a book through a specific
  problem-lens instead of personalizing to the whole reader.
- `skills/article-enrichment/SKILL.md` — same shape applied to articles
  rather than books.


## Contract

This skill guarantees:

- Routing matches the canonical triggers in the frontmatter.
- Output written under the directories listed in `writes_to:` (when applicable).
- Conventions referenced (`quality.md`, `brain-first.md`, `_brain-filing-rules.md`) are followed.
- Trust contract preserved in both modes: per-chapter workers are read-only;
  exactly one operator-trust write emits the final page.
- Privacy contract preserved: no real names, no fork-specific filesystem path literals, no upstream-fork references.

The full behavior contract is documented in the body sections above; this section exists for the conformance test.

## Output Format

The skill's output shape is documented inline in the body sections above (see
"5. Assemble + write" for the page shape and "4. Fan-out" for the per-chapter
two-column section). The literal section header here exists for the conformance
test (`test/skills-conformance.test.ts`).

## Anti-Patterns

The full anti-pattern list is in the body sections above; this header exists for the conformance test if the body uses a different casing.
