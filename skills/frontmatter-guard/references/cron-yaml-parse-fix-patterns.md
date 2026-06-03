# YAML_PARSE manual fix patterns (cron / headless context)

Captured from daily-frontmatter cron run 2026-05-28.
The `gbrain frontmatter validate . --fix` flag did NOT fix any of the 5
YAML_PARSE issues found. Each required manual intervention.

## Pattern 1: Wikilinks in YAML scalars (`[[...]]`)

**Root cause:** YAML sees `[[cloudflare]]` or `[[topic/foo|bar]]` and interprets
it as a nested flow sequence, not a plain string.

**Files affected:** `sources:`, `related:`, and any field with Obsidian-style
wikilinks in unquoted values.

**Fix: single-quote the entire scalar**

```yaml
# Broken
related: [[learnings/pitfalls/2026-05-09-quirks|2026-05-09-quirks]], [[learnings/patterns/2026-05-04-pattern|2026-05-04-pattern]]

# Fixed
related: '[[learnings/pitfalls/2026-05-09-quirks|2026-05-09-quirks]], [[learnings/patterns/2026-05-04-pattern|2026-05-04-pattern]]'
```

For YAML block list items starting with `[[`:
```yaml
sources:
  - '既有 brain 頁 [[cloudflare]]（org case-study）'
  - '[[topics/stocks/cybersecurity-us-2026|cybersecurity-us-2026]] hub（Cloud Sec）'
```

## Pattern 2: Unquoted colon in title/description

**Root cause:** `title: Offer Files: shared liquidity without a chain` — the
second colon is interpreted as a YAML key-value separator.

**Fix: single-quote the value**

```yaml
# Broken
title: Offer Files: shared liquidity without a chain

# Fixed
title: 'Offer Files: shared liquidity without a chain'
```

## Pattern 3: `branch: -` interpreted as sequence indicator

**Root cause:** `branch: -` — YAML interprets the `-` as the start of a block
sequence.

**Fix: single-quote the value**

```yaml
# Broken
branch: -

# Fixed
branch: '-'
```

## Pattern 4: Unquoted `[[wikilink|alias]]` with pipe in YAML

**Root cause:** The `|` inside `[[...|...]]` combined with `[[` creates a YAML
flow sequence with an inline pipe syntax, which is invalid.

**Fix:** Same as Pattern 1 — single-quote the entire scalar.

## Pattern 5: Title starting with `@` (Twitter handle) or backtick `` ` ``

**Root cause:** In YAML 1.1, `@` is a reserved indicator, and some parsers
(including gbrain's `js-yaml`) treat it as such when it appears as the first
character of an unquoted scalar. The same applies to the backtick `` ` ``.
The error manifests as:

```
YAML parse failed: end of the stream or a document separator is expected at line N, column 8:
    title: @username — Some description
           ^
```

Found in 5 files on 2026-05-29 — all had `title:` values starting with `@`
(Twitter/X handles like `@lmsysorg`, `@cursor_ai`, `@Mnilax`, `@runes_leo`)
or backtick (`` `/goal` Prompt Structure ... ``).

**Fix: single-quote the entire title value**

```yaml
# Broken
title: @lmsysorg — Fastokens merged into SGLang
title: @Mnilax (Mnimiy)
title: `/goal` Prompt Structure — 給 Codex

# Fixed
title: '@lmsysorg — Fastokens merged into SGLang'
title: '@Mnilax (Mnimiy)'
title: '`/goal` Prompt Structure — 給 Codex'
```

**Note on tagged/alias arrays:** when `--fix` runs, it may also normalize
double-quoted tag/alias arrays (`tags: ["a", "b"]` → `tags: ['a', 'b']`)
for the same files. This is a separate fix from the YAML_PARSE. The
YAML_PARSE on `title:` will NOT be auto-fixed.

**Prevention:** always quote `title:` values that start with `@`, `` ` ``,
`*`, `&`, `!`, `|`, `>`, `%`, or `#`.

## Verifying the fix

```bash
cd /Users/panda/site/knowledge/brain
gbrain frontmatter validate .   # should no longer list the fixed file
gbrain frontmatter validate . --json | jq '.total_files, .files_with_errors'
```

## Backup policy

Before any manual edit, copy the file:
```
cp path/to/file.md path/to/file.md.bak.$(date +%Y-%m-%d)
```