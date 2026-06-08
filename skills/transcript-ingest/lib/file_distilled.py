#!/usr/bin/env python3
"""File everything in _distilled/ into the brain. Reusable by the manual flow
and the SessionEnd auto-distill hook.

Routing (Panda 2026-06-01):
  personal              -> brain/sessions/<date>-<slug>.md
  industry / yei / dup  -> brain/inbox/transcript-ingest/ (manual entity-level
                           filing / dup review; work-vault is OFF-LIMITS)

Collision: a personal note whose date (+/-1d) and >=2 slug tokens match an
existing session is routed to inbox flagged `possible-dup-of` instead of
silently overwriting. Date comes from the source key (codex/hermes) or the
source jsonl mtime (claude).
"""
import json
import os
import re
import glob
import datetime

HOME = os.path.expanduser("~")
STAGING = os.environ.get(
    "TI_STAGING", os.path.join(HOME, "site/knowledge/brain/.raw/transcript-ingest"))
SESS = os.path.join(HOME, "site/knowledge/brain/sessions")
INBOX = os.path.join(HOME, "site/knowledge/brain/inbox/transcript-ingest")
STATE = os.path.join(STAGING, "state.json")
DIST = os.path.join(STAGING, "_distilled")
LEARN = os.path.join(HOME, "site/knowledge/brain/learnings")
CATMAP = {"pitfall": "pitfalls", "pattern": "patterns", "architecture": "architecture"}
STOP = set("the a an and or of to for in on with vs new shipped fix bug decision design".split())
DATE_RE = re.compile(r"^(20\d\d)-(\d\d)-(\d\d)")


def sess_date(key, path):
    m = re.search(r"(20\d\d)-?(\d\d)-?(\d\d)", key)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    try:
        return datetime.date.fromtimestamp(os.path.getmtime(path)).isoformat()
    except Exception:
        return datetime.date.today().isoformat()


def toks(slug):
    return set(t for t in re.split(r"[^a-z0-9]+", slug.lower())
               if t and t not in STOP and len(t) > 2)


def index_filed_keys():
    """source_key -> first already-filed path, across sessions/ + inbox/.

    Filing was keyed by the LLM-generated title-slug, which varies per run, so a
    grown session that re-queues + re-distills produced a NEW file instead of
    updating — spawning duplicate notes for one source_key (observed 2026-06-02).
    Index by the stable source_key so an already-filed session is skipped, not
    re-filed. (Skip, not overwrite: never clobber a note Panda may have curated.)
    """
    idx = {}
    for d in (SESS, INBOX):
        for f in glob.glob(os.path.join(d, "*.md")):
            try:
                head = open(f, encoding="utf-8", errors="ignore").read(1500)
            except Exception:
                continue
            m = re.search(r"^source_key:\s*(\S+)", head, re.M)
            if m:
                idx.setdefault(m.group(1), f)
    return idx


def index_learning_keys():
    """source_key set across brain/learnings/, so a re-distilled session does not
    re-promote a learning it already produced (mirrors index_filed_keys for sessions)."""
    keys = set()
    for f in glob.glob(os.path.join(LEARN, "**", "*.md"), recursive=True):
        try:
            head = open(f, encoding="utf-8", errors="ignore").read(1500)
        except Exception:
            continue
        m = re.search(r"^source_key:\s*(\S+)", head, re.M)
        if m:
            keys.add(m.group(1))
    return keys


def promote_learning(body, key, d, slug, title, learned_keys):
    """Promote a personal session's `## Reusable learning` to a typed learnings/ page.
    Returns 1 if a page was written, else 0. The caller wraps this in try/except so a
    failed promotion never blocks the session file from being removed/counted.

    Guards: `learning:` is read from the FRONTMATTER block only (not the body);
    source_key dedup (skip if already promoted); key char-validation before it enters
    YAML frontmatter; collision-safe output path (never overwrites a sibling learning
    with a different source_key). Schema matches the brain learnings corpus:
    `type: learning` + subtype via the CATMAP directory, `confidence: low` (auto +
    unverified until promoted), `tags: [auto-learning, <cat>]`."""
    fm = body.split("---", 2)
    fmblock = fm[1] if len(fm) >= 3 else ""
    lc = re.search(r"^learning:\s*(\w+)", fmblock, re.M)
    if not lc or lc.group(1) not in CATMAP or key in learned_keys:
        return 0
    if not re.fullmatch(r"[A-Za-z0-9_.\-]+", key):
        print(f"learning-promote skipped: unsafe source_key {key!r}")
        return 0
    lm = re.search(r"^## Reusable learning\s*\n(.*?)(?=^## |\Z)", body, re.M | re.S)
    lbody = lm.group(1).strip() if lm else ""
    if not lbody:
        print(f"learning-promote skipped: {key} tagged learning:{lc.group(1)} but empty body")
        return 0
    cat = lc.group(1)
    ldir = os.path.join(LEARN, CATMAP[cat])
    os.makedirs(ldir, exist_ok=True)
    lpath = os.path.join(ldir, f"{d}-{slug}.md")
    n = 2
    while os.path.exists(lpath):
        lpath = os.path.join(ldir, f"{d}-{slug}-{n}.md")
        n += 1
    front = (f"---\ntype: learning\nkey: {slug}\ndate: {d}\n"
             f"source_key: {key}\nsource: transcript-ingest\n"
             f"confidence: low\ntags: [auto-learning, {cat}]\n---\n\n")
    open(lpath, "w").write(front + f"# {title}\n\n" + lbody + "\n")
    learned_keys.add(key)
    return 1


def main():
    state = json.load(open(STATE)) if os.path.exists(STATE) else {}
    filed_keys = index_filed_keys()
    learned_keys = index_learning_keys()
    existing = {}
    for f in glob.glob(os.path.join(SESS, "*.md")):
        b = os.path.basename(f)[:-3]
        if not DATE_RE.match(b):
            continue
        existing.setdefault(b[:10], []).append((b, toks(b[11:])))

    filed = inboxed = skipped = learned = 0
    for md in sorted(glob.glob(os.path.join(DIST, "**", "*.md"), recursive=True)):
        dom = os.path.basename(os.path.dirname(md))
        key = os.path.basename(md)[:-3]
        if key in filed_keys:
            os.remove(md)
            skipped += 1
            continue
        body = open(md).read()
        title = next((l.split(":", 1)[1].strip()
                      for l in body.splitlines() if l.startswith("title:")), key)
        d = sess_date(key, state.get(key, {}).get("path", ""))
        di = int(d.replace("-", ""))
        slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:50]
        mt = toks(slug)
        body = re.sub(r"^date:.*$", f"date: {d}", body, count=1, flags=re.M)
        collide = None
        for dd, items in existing.items():
            if abs(int(dd.replace("-", "")) - di) <= 1:
                for b, tk in items:
                    if len(mt & tk) >= 2:
                        collide = b
                        break
            if collide:
                break
        if dom != "personal" or collide:
            os.makedirs(INBOX, exist_ok=True)
            flag = (f"<!-- transcript-ingest: domain={dom}" +
                    (f", possible-dup-of={collide}" if collide else ", needs entity-level filing") +
                    " -->\n")
            open(os.path.join(INBOX, f"{d}-{slug}.md"), "w").write(flag + body)
            os.remove(md)
            inboxed += 1
        else:
            open(os.path.join(SESS, f"{d}-{slug}.md"), "w").write(body)
            existing.setdefault(d, []).append((slug, mt))
            try:
                learned += promote_learning(body, key, d, slug, title, learned_keys)
            except Exception as e:
                print(f"learning-promote failed for {key}: {e}")
            os.remove(md)
            filed += 1
    print(f"filed->sessions {filed} | inboxed {inboxed} | "
          f"learned {learned} | skipped-dup {skipped}")


if __name__ == "__main__":
    main()
