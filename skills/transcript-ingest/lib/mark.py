#!/usr/bin/env python3
"""Mark distilled sessions done in state.json so they never re-gate.

Usage: echo "<key>|<SIGNAL|NOISE>|<domain>" | python mark.py
       (one verdict per line, from distill workers' report lines)

A done session keeps its verdict/domain; if the source jsonl later GROWS,
collect.py records needs_update without re-queueing it as a fresh distill.
Override staging with env TI_STAGING.
"""
import json
import os
import sys
import tempfile
import fcntl

from state_io import load_state

HOME = os.path.expanduser("~")
STAGING = os.environ.get(
    "TI_STAGING", os.path.join(HOME, "site/knowledge/brain/.raw/transcript-ingest"))
STATE = os.path.join(STAGING, "state.json")
STATE_LOCK = STATE + ".lock"


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


def main():
    os.makedirs(STAGING, exist_ok=True)
    lock = open(STATE_LOCK, "a+")
    fcntl.flock(lock, fcntl.LOCK_EX)
    state = load_state(STATE)
    n = 0
    for line in sys.stdin:
        line = line.strip().strip("`")
        if not line or "|" not in line:
            continue
        parts = [p.strip() for p in line.split("|")]
        key, verdict = parts[0], parts[1].upper()
        domain = parts[2] if len(parts) > 2 else "none"
        artifact = parts[3] if len(parts) > 3 else ""
        if key not in state:
            continue
        if "SIGNAL" in verdict and not (artifact.startswith("/") and os.path.exists(artifact)):
            print(f"skipped invalid SIGNAL report for {key}: missing artifact {artifact!r}")
            continue
        state[key]["status"] = "done"
        state[key]["verdict"] = "SIGNAL" if "SIGNAL" in verdict else "NOISE"
        state[key]["domain"] = domain
        n += 1
    atomic_dump(state, STATE)
    fcntl.flock(lock, fcntl.LOCK_UN)
    lock.close()
    done = sum(1 for v in state.values() if v.get("status") == "done")
    sig = sum(1 for v in state.values() if v.get("verdict") == "SIGNAL")
    pend = sum(1 for v in state.values() if v.get("status") == "queued")
    print(f"marked {n} | done {done} | SIGNAL {sig} | pending {pend}")


if __name__ == "__main__":
    main()
