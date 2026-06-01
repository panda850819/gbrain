#!/usr/bin/env python3
"""Unified transcript normalizer for Claude Code / Codex / Hermes jsonl.

Each source has a different line schema; all reduce to a list of (role, text)
human/assistant turns with tool noise + injected-context boilerplate stripped.
"""
import json

# ---- injected boilerplate we never want as "human text" ----
_BOILERPLATE_PREFIXES = (
    "# AGENTS.md instructions for",
    "<system-reminder>",
    "Caveat: The messages below were generated",
    "<command-name>",
    "<local-command-stdout>",
)


def _clean(t: str) -> str:
    return (t or "").strip()


def _is_boilerplate(t: str) -> bool:
    return any(t.startswith(p) for p in _BOILERPLATE_PREFIXES)


def _text_from_blocks(content):
    """Claude Code / Codex content may be str or list-of-blocks."""
    if isinstance(content, str):
        return _clean(content)
    if isinstance(content, list):
        parts = []
        for b in content:
            if not isinstance(b, dict):
                continue
            if b.get("type") in ("text", "input_text", "output_text"):
                parts.append(b.get("text", ""))
            # skip tool_use / tool_result / reasoning / image blocks
        return _clean("\n".join(p for p in parts if p))
    return ""


def _norm_claude(path):
    turns = []
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get("type") not in ("user", "assistant"):
            continue
        m = d.get("message") or {}
        role = m.get("role")
        if role not in ("user", "assistant"):
            continue
        t = _text_from_blocks(m.get("content"))
        if not t or _is_boilerplate(t):
            continue
        if role == "user" and t.startswith("[{"):  # tool-result-only turn
            continue
        turns.append((role, t))
    return turns


def _norm_codex(path):
    turns = []
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get("type") != "response_item":
            continue
        p = d.get("payload") or {}
        if p.get("type") != "message":
            continue
        role = p.get("role")
        if role not in ("user", "assistant"):  # drop developer/system
            continue
        t = _text_from_blocks(p.get("content"))
        if not t or _is_boilerplate(t):
            continue
        turns.append((role, t))
    return turns


def _norm_hermes(path):
    turns = []
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        role = d.get("role")
        if role not in ("user", "assistant"):  # drop tool/session_meta
            continue
        t = _clean(d.get("content") if isinstance(d.get("content"), str) else "")
        if not t or _is_boilerplate(t):
            continue
        turns.append((role, t))
    return turns


_PARSERS = {"claude": _norm_claude, "codex": _norm_codex, "hermes": _norm_hermes}


def normalize(path, source):
    return _PARSERS[source](path)


def to_text(turns):
    return "".join(f"[{r}] {t}\n\n" for r, t in turns)


def stats(turns):
    human = sum(len(t) for r, t in turns if r == "user")
    total = sum(len(t) for _, t in turns)
    return {"turns": len(turns), "human_chars": human, "total_chars": total}
