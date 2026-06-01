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


def main():
    state = json.load(open(STATE)) if os.path.exists(STATE) else {}
    existing = {}
    for f in glob.glob(os.path.join(SESS, "*.md")):
        b = os.path.basename(f)[:-3]
        if not DATE_RE.match(b):
            continue
        existing.setdefault(b[:10], []).append((b, toks(b[11:])))

    filed = inboxed = 0
    for md in sorted(glob.glob(os.path.join(DIST, "**", "*.md"), recursive=True)):
        dom = os.path.basename(os.path.dirname(md))
        key = os.path.basename(md)[:-3]
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
            os.remove(md)
            filed += 1
    print(f"filed->sessions {filed} | inboxed {inboxed}")


if __name__ == "__main__":
    main()
