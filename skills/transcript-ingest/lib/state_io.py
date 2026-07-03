"""Self-healing state.json IO shared by transcript-ingest lib scripts.

Same-dir import target: when a sibling script is invoked as
`python3 <lib>/<script>.py`, sys.path[0] is this directory, so
`from state_io import load_state` resolves without sys.path edits
(mirrors collect.py's `from normalize import ...`). Side-effect free:
no module-level work, safe to import.

The readers (mark.py / distill_batch.py / file_distilled.py and the
drain_pending.sh heredoc) used to call `json.load(open(STATE))` raw, so a
state.json corrupted by overlapping writers crashed the collector. This
shares collect.py's repair + atomic-write logic with them.
"""
import json
import os
import re
import shutil
import tempfile
import time


def load_state(path):
    """Load state.json, self-healing the adjacent-object corruption that
    overlapping writers produce: `...}\\n}"claude__...` -> `...},\\n"claude__...`.
    Returns {} if absent. Re-raises the original JSONDecodeError if the repair
    still does not parse."""
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        raw = f.read()
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        repaired = re.sub(r'\n}\s*"(claude__|codex__|hermes__)', r',\n"\1', raw, count=1)
        try:
            obj = json.loads(repaired)
        except Exception:
            raise e
        shutil.copy2(path, path + ".corrupt-bak")
        atomic_dump(obj, path)
        return obj


def atomic_dump(obj, path):
    """Write obj as JSON to path via tmp file + os.replace (atomic, no torn writes)."""
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


def settled_queued_keys(state, settle_min, cap, now=None, getmtime=os.path.getmtime):
    """Return queued keys whose source transcript has settled, in drain priority order."""
    if now is None:
        now = time.time()
    rows = []
    for k, v in state.items():
        if v.get("status") != "queued":
            continue
        p = v.get("path", "")
        try:
            age = now - getmtime(p)
        except OSError:
            age = 1e9  # source gone -> treat as settled
        if age < settle_min * 60:
            continue
        rows.append((v.get("user_turns", 0) * 2000 + v.get("human_chars", 0), k))
    rows.sort(reverse=True)
    return [k for _, k in rows[:cap]]
