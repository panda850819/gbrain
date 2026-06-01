#!/usr/bin/env python3
"""Emit a batch of distill-worker dispatch specs for the agent to fan out.

Pure python: reads the pending manifest and prints, for the next N sessions,
the absolute paths a distill worker needs. The AGENT (not this script) then
spawns one free CC subagent per spec, collects the report lines, and pipes
them to mark.py. This keeps deterministic work in python and LLM work in
subagents (Mode A: free in-harness agents, never a paid CLI binary).

Usage: python distill_batch.py [N]   # default 20
Override staging with env TI_STAGING.
"""
import json
import os
import sys

HOME = os.path.expanduser("~")
STAGING = os.environ.get(
    "TI_STAGING", os.path.join(HOME, "site/knowledge/brain/.raw/transcript-ingest"))
SKILL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(STAGING, "state.json")
QUEUE = os.path.join(STAGING, "_queue")
DISTILL_PROMPT = os.path.join(SKILL, "prompts", "distill_prompt.md")


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 20
    # Derive pending straight from state (status==queued) so a freshly-marked
    # batch is reflected immediately — the manifest is only refreshed by collect.
    state = json.load(open(STATE))
    pending = [{"key": k, "source": v["source"], "human_chars": v["human_chars"]}
               for k, v in state.items() if v.get("status") == "queued"]
    pending.sort(key=lambda m: m["human_chars"], reverse=True)
    batch = pending[:n]
    spec = {
        "distill_prompt": DISTILL_PROMPT,
        "distilled_dir": os.path.join(STAGING, "_distilled"),
        "count": len(batch),
        "remaining": len(pending) - len(batch),
        "workers": [
            {"key": m["key"],
             "session_file": os.path.join(QUEUE, m["key"] + ".txt"),
             "source": m["source"], "human_chars": m["human_chars"]}
            for m in batch
        ],
    }
    print(json.dumps(spec, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
