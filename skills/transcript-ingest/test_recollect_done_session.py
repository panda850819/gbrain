#!/usr/bin/env python3
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
import warnings


ROOT = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(ROOT, "lib")
sys.path.insert(0, LIB)

import collect
from state_io import atomic_dump, load_state, settled_queued_keys


def codex_message(role, text):
    block_type = "input_text" if role == "user" else "output_text"
    return {
        "type": "response_item",
        "payload": {
            "type": "message",
            "role": role,
            "content": [{"type": block_type, "text": text}],
        },
    }


def append_jsonl(path, rows):
    with open(path, "a") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")


class RecollectDoneSessionTest(unittest.TestCase):
    def run_collect(self):
        with contextlib.redirect_stdout(io.StringIO()):
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", ResourceWarning)
                collect.main()

    def test_grown_done_session_preserves_classification_and_drain_skips_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            sessions = os.path.join(tmp, "sessions")
            staging = os.path.join(tmp, "staging")
            os.makedirs(sessions)
            transcript = os.path.join(sessions, "2026-07-03-session.jsonl")
            append_jsonl(transcript, [
                codex_message("user", "Initial decision context. " * 12),
                codex_message("assistant", "Filed response."),
            ])

            collect.STAGING = staging
            collect.STATE = os.path.join(staging, "state.json")
            collect.STATE_LOCK = collect.STATE + ".lock"
            collect.QUEUE = os.path.join(staging, "_queue")
            collect.MANIFEST = os.path.join(staging, "_manifest.json")
            collect.SOURCES = [("codex", os.path.join(sessions, "*.jsonl"))]

            self.run_collect()
            key = "codex__2026-07-03-session"
            qfile = os.path.join(collect.QUEUE, key + ".txt")
            self.assertTrue(os.path.exists(qfile))

            state = load_state(collect.STATE)
            old_sha = state[key]["sha"]
            state[key].update({
                "status": "done",
                "verdict": "SIGNAL",
                "domain": "personal",
                "filed_path": "/brain/sessions/2026-07-03-session.md",
                "learning_path": "/brain/learnings/patterns/2026-07-03-session.md",
            })
            atomic_dump(state, collect.STATE)

            append_jsonl(transcript, [
                codex_message("user", "Additional follow-up with durable implementation detail. " * 8),
                codex_message("assistant", "Acknowledged."),
            ])

            self.run_collect()

            state = load_state(collect.STATE)
            entry = state[key]
            self.assertEqual(entry["status"], "done")
            self.assertEqual(entry["verdict"], "SIGNAL")
            self.assertEqual(entry["domain"], "personal")
            self.assertEqual(entry["filed_path"], "/brain/sessions/2026-07-03-session.md")
            self.assertEqual(
                entry["learning_path"],
                "/brain/learnings/patterns/2026-07-03-session.md",
            )
            self.assertTrue(entry["needs_update"])
            self.assertEqual(entry["needs_update_from_sha"], old_sha)
            self.assertNotEqual(entry["sha"], old_sha)
            self.assertFalse(os.path.exists(qfile))

            manifest = load_state(collect.MANIFEST)
            self.assertEqual(manifest, [])

            pending_key = "codex__pending"
            state[pending_key] = {
                "sha": "pending",
                "status": "queued",
                "source": "codex",
                "path": transcript,
                "turns": 2,
                "user_turns": 1,
                "human_chars": 250,
                "total_chars": 260,
            }
            selected = settled_queued_keys(
                state,
                settle_min=0,
                cap=10,
                now=1000,
                getmtime=lambda _path: 0,
            )
            self.assertIn(pending_key, selected)
            self.assertNotIn(key, selected)


if __name__ == "__main__":
    unittest.main()
