#!/usr/bin/env python3
"""Collector: scan all agent transcript sources, dedup, normalize, queue.

Deterministic + zero LLM. Three cheap filters BEFORE the LLM gate:
  1. dedup   — skip sessions already processed (key = source+id, content sha)
  2. thin    — skip sessions with too little human text (pure tool/noise)
  3. growth  — re-queue a session only if its content hash changed

Staging (queue + state + distilled) lives in the brain repo under .raw/, which
gbrain import/embed skips, so raw working files never pollute the brain DB.
Override with env TI_STAGING.
"""
import json
import os
import sys
import glob
import hashlib
import tempfile
import shutil
import fcntl

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from normalize import normalize, to_text, stats

HOME = os.path.expanduser("~")
STAGING = os.environ.get(
    "TI_STAGING", os.path.join(HOME, "site/knowledge/brain/.raw/transcript-ingest"))
STATE = os.path.join(STAGING, "state.json")
STATE_LOCK = STATE + ".lock"
QUEUE = os.path.join(STAGING, "_queue")
MANIFEST = os.path.join(STAGING, "_manifest.json")

# (source, recursive glob) — where each agent leaves its jsonl
SOURCES = [
    ("claude", os.path.join(HOME, ".claude/projects/**/*.jsonl")),
    ("codex",  os.path.join(HOME, ".codex/sessions/**/*.jsonl")),
    ("codex",  os.path.join(HOME, ".codex/archived_sessions/*.jsonl")),
    ("hermes", os.path.join(HOME, ".hermes/sessions/**/*.jsonl")),
]

MIN_HUMAN_CHARS = 200  # below this = thin/noise, never worth the LLM gate


def _is_sidechain(path):
    # Sub-agent sidechains are fragments of a parent session (parent already
    # carries the human intent). Skip by design — counted + reported, never silent.
    return "/subagents/" in path or os.path.basename(path).startswith("agent-")


# Distilling spawns its own headless/subagent sessions (the worker is fed the
# gate + distill prompts plus the pasted source). Those land as fresh top-level
# jsonl and collect re-ingests them — a self-pollution loop that buried the real
# backlog (4.6K of 4.7K pending were meta-worker runs, 2026-06-02). Skip any
# session whose content is itself a distill-worker invocation.
_META_MARKERS = (
    "transcript distill worker",
    "signal gate for a transcript-ingest pipeline",
    "You process ONE normalized session end-to-end",
)


def _is_distill_worker(text):
    head = text[:4000]
    return any(m in head for m in _META_MARKERS)


# Disposable-artifact crons (e.g. the daily 台股 morning-note generator) consume
# brain context and emit a one-off dated line. The gate always rules them NOISE,
# so skip at collect to keep them out of the queue rather than paying a gate each.
_DISPOSABLE_MARKERS = (
    "你是台股籌碼分析師",
    "寫成「一句」繁中敘事",
)


def _is_disposable_artifact(text):
    head = text[:2000]
    return any(m in head for m in _DISPOSABLE_MARKERS)


def locked_state():
    os.makedirs(STAGING, exist_ok=True)
    lock = open(STATE_LOCK, "a+")
    fcntl.flock(lock, fcntl.LOCK_EX)
    return lock


def load_state():
    if not os.path.exists(STATE):
        return {}
    raw = open(STATE).read()
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        # Self-heal the observed adjacent-object corruption caused by overlapping
        # writers: ...}\n}"claude__..." -> ...},\n"claude__..."
        import re
        repaired = re.sub(r'\n}\s*"(claude__|codex__|hermes__)', r',\n"\1', raw, count=1)
        try:
            obj = json.loads(repaired)
        except Exception:
            raise e
        backup = STATE + ".corrupt-bak"
        shutil.copy2(STATE, backup)
        atomic_dump(obj, STATE)
        return obj


def atomic_dump(obj, path):
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(prefix=os.path.basename(path) + ".", suffix=".tmp", dir=d)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(obj, f, ensure_ascii=False, indent=0)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def key_for(source, path):
    return f"{source}__{os.path.basename(path)[:-6]}"  # strip .jsonl


def main():
    os.makedirs(QUEUE, exist_ok=True)
    lock = locked_state()
    state = load_state()
    counts = {"scanned": 0, "sidechain": 0, "meta": 0, "artifact": 0,
              "new": 0, "requeued": 0, "dedup": 0, "thin": 0, "empty": 0}

    for source, pat in SOURCES:
        for path in glob.glob(pat, recursive=True):
            if _is_sidechain(path):
                counts["sidechain"] += 1
                continue
            counts["scanned"] += 1
            k = key_for(source, path)
            try:
                turns = normalize(path, source)
            except Exception:
                continue
            if not turns:
                counts["empty"] += 1
                continue
            st = stats(turns)
            if st["human_chars"] < MIN_HUMAN_CHARS:
                counts["thin"] += 1
                continue
            text = to_text(turns)
            if _is_distill_worker(text):
                counts["meta"] += 1
                continue
            if _is_disposable_artifact(text):
                counts["artifact"] += 1
                continue
            sha = hashlib.sha256(text.encode()).hexdigest()[:16]
            prev = state.get(k)
            qfile = os.path.join(QUEUE, k + ".txt")
            if prev and prev.get("sha") == sha:
                counts["dedup"] += 1
                # Self-heal: a still-pending session must keep its queue file on
                # disk even when deduped (e.g. after a staging move that copied
                # state.json but not _queue/). Regenerate if missing.
                if prev.get("status") == "queued" and not os.path.exists(qfile):
                    open(qfile, "w").write(text)
                continue
            open(qfile, "w").write(text)
            state[k] = {"sha": sha, "status": "queued",
                        "source": source, "path": path, **st}
            counts["new" if not prev else "requeued"] += 1

    atomic_dump(state, STATE)
    # Manifest = everything still PENDING distill across all runs, not just
    # this run's new items, so re-running collect never drops a pending session.
    pending = [{"key": k, "source": v["source"], "turns": v["turns"],
                "human_chars": v["human_chars"], "total_chars": v["total_chars"]}
               for k, v in state.items() if v.get("status") == "queued"]
    pending.sort(key=lambda m: m["human_chars"], reverse=True)
    atomic_dump(pending, MANIFEST)
    fcntl.flock(lock, fcntl.LOCK_UN)
    lock.close()

    print("== collect ==")
    for k, v in counts.items():
        print(f"  {k:10s} {v}")
    by_src = {}
    for m in pending:
        by_src[m["source"]] = by_src.get(m["source"], 0) + 1
    print(f"  pending -> {len(pending)} sessions {by_src}")
    print(f"  staging: {STAGING}")


if __name__ == "__main__":
    main()
