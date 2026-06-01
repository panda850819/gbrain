#!/usr/bin/env python3
"""Mark distilled sessions done in state.json so they never re-gate.

Usage: echo "<key>|<SIGNAL|NOISE>|<domain>" | python mark.py
       (one verdict per line, from distill workers' report lines)

A done session keeps its sha; if the source jsonl later GROWS, collect.py sees
a new sha and re-queues it (status flips back to queued) for re-distill.
Override staging with env TI_STAGING.
"""
import json
import os
import sys

HOME = os.path.expanduser("~")
STAGING = os.environ.get(
    "TI_STAGING", os.path.join(HOME, "site/knowledge/brain/.raw/transcript-ingest"))
STATE = os.path.join(STAGING, "state.json")


def main():
    state = json.load(open(STATE))
    n = 0
    for line in sys.stdin:
        line = line.strip().strip("`")
        if not line or "|" not in line:
            continue
        parts = [p.strip() for p in line.split("|")]
        key, verdict = parts[0], parts[1].upper()
        domain = parts[2] if len(parts) > 2 else "none"
        if key not in state:
            continue
        state[key]["status"] = "done"
        state[key]["verdict"] = "SIGNAL" if "SIGNAL" in verdict else "NOISE"
        state[key]["domain"] = domain
        n += 1
    json.dump(state, open(STATE, "w"), ensure_ascii=False, indent=0)
    done = sum(1 for v in state.values() if v.get("status") == "done")
    sig = sum(1 for v in state.values() if v.get("verdict") == "SIGNAL")
    pend = sum(1 for v in state.values() if v.get("status") == "queued")
    print(f"marked {n} | done {done} | SIGNAL {sig} | pending {pend}")


if __name__ == "__main__":
    main()
