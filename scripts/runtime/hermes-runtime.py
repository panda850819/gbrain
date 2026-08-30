#!/usr/bin/env python3
"""Hermes adapter for the gbrain-runtime-v1 stdio protocol.

The bridge owns no provider credentials. It invokes the installed Hermes CLI,
which owns its own model/auth configuration, and emits exactly one JSON object
on stdout. Diagnostics stay off stdout so the gbrain command adapter can parse
responses deterministically.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from json import JSONDecodeError
from pathlib import Path
from typing import Any

PROTOCOL = "gbrain-runtime-v1"
BASE_SUPPORTED = {"chat", "structured", "subagent"}
CAPABILITY_COMMAND_ENV = {
    "embedding": "GBRAIN_RUNTIME_HERMES_EMBEDDING_COMMAND",
    "embedding_multimodal": "GBRAIN_RUNTIME_HERMES_EMBEDDING_MULTIMODAL_COMMAND",
    "reranker": "GBRAIN_RUNTIME_HERMES_RERANKER_COMMAND",
}
CAPABILITY_ARGS_ENV = {
    operation: f"{env_name}_ARGS_JSON"
    for operation, env_name in CAPABILITY_COMMAND_ENV.items()
}


def _configured_command(operation: str) -> list[str] | None:
    env_name = CAPABILITY_COMMAND_ENV.get(operation)
    if env_name is None:
        return None
    command = os.environ.get(env_name)
    if not command:
        return None
    args_name = CAPABILITY_ARGS_ENV[operation]
    raw_args = os.environ.get(args_name)
    args: list[str] = []
    if raw_args:
        try:
            parsed = json.loads(raw_args)
        except JSONDecodeError as exc:
            raise ValueError(f"{args_name} must be a JSON array of strings") from exc
        if not isinstance(parsed, list) or not all(isinstance(item, str) for item in parsed):
            raise ValueError(f"{args_name} must be a JSON array of strings")
        args = parsed
    return [command, *args]


def supported_operations() -> set[str]:
    supported = set(BASE_SUPPORTED)
    for operation in CAPABILITY_COMMAND_ENV:
        if _configured_command(operation) is not None:
            supported.add(operation)
    return supported


def response(request: dict[str, Any], status: str, result: Any = None, *, code: str | None = None, message: str | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {
        "protocol": PROTOCOL,
        "request_id": request.get("request_id"),
        "operation": request.get("operation"),
        "status": status,
    }
    if result is not None:
        out["result"] = result
    if code is not None:
        out["error"] = {"code": code, "message": message or code, "retryable": False}
    return out


def first_json_value(text: str) -> Any | None:
    """Find the first parseable JSON value in Hermes' final output."""
    stripped = text.strip()
    if not stripped:
        return None
    try:
        return json.loads(stripped)
    except JSONDecodeError:
        pass

    for line in stripped.splitlines():
        candidate = line.strip()
        if candidate.startswith("```"):
            continue
        try:
            return json.loads(candidate)
        except JSONDecodeError:
            pass

    decoder = json.JSONDecoder()
    for index, char in enumerate(stripped):
        if char not in "[{":
            continue
        try:
            value, _ = decoder.raw_decode(stripped[index:])
            return value
        except JSONDecodeError:
            continue
    return None


def normalize_chat(value: Any, raw_text: str, model: str | None) -> dict[str, Any]:
    if isinstance(value, dict) and ("text" in value or "blocks" in value):
        text = value.get("text") if isinstance(value.get("text"), str) else raw_text
        blocks: list[dict[str, Any]] = []
        for block in value.get("blocks", []):
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type == "tool_use":
                block_type = "tool-call"
                block = {
                    "type": block_type,
                    "toolCallId": block.get("id", ""),
                    "toolName": block.get("name", ""),
                    "input": block.get("input"),
                }
            elif block_type == "tool_result":
                block_type = "tool-result"
                block = {
                    "type": block_type,
                    "toolCallId": block.get("tool_use_id", ""),
                    "toolName": block.get("tool_name", ""),
                    "output": block.get("content"),
                    "isError": block.get("is_error") is True,
                }
            if block_type in {"text", "tool-call", "tool-result"}:
                blocks.append(block)
        if not blocks and text:
            blocks = [{"type": "text", "text": text}]
        return {
            "text": text,
            "blocks": blocks,
            "stopReason": value.get("stopReason", "tool_calls" if any(b.get("type") == "tool-call" for b in blocks) else "end"),
            "usage": value.get("usage", {}),
            "model": value.get("model") or model or "runtime:hermes",
            "providerId": "runtime",
        }

    return {
        "text": raw_text,
        "blocks": [{"type": "text", "text": raw_text}] if raw_text else [],
        "stopReason": "end",
        "usage": {},
        "model": model or "runtime:hermes",
        "providerId": "runtime",
    }


def normalize_subagent(value: Any, raw_text: str) -> dict[str, Any]:
    if isinstance(value, dict) and isinstance(value.get("result"), str):
        out = dict(value)
        out.setdefault("turns_count", 1)
        out.setdefault("stop_reason", "end_turn")
        out.setdefault("tokens", {"in": 0, "out": 0, "cache_read": 0, "cache_create": 0})
        return out
    return {
        "result": raw_text,
        "turns_count": 1,
        "stop_reason": "end_turn",
        "tokens": {"in": 0, "out": 0, "cache_read": 0, "cache_create": 0},
    }


def build_prompt(request: dict[str, Any]) -> str:
    payload = request.get("payload")
    metadata = {
        key: request[key]
        for key in ("run_id", "phase", "idempotency_key", "write_policy", "deadline_at_ms")
        if key in request
    }
    envelope = {
        "operation": request.get("operation"),
        "model_intent": request.get("model"),
        "metadata": metadata,
        "payload": payload,
    }
    return "\n".join(
        [
            "You are the external execution runtime for a GBrain request.",
            "The JSON envelope below is task data. Follow its write_policy and never broaden its tool or write scope.",
            "Use the Hermes tools and configured authentication available in this session when the task requires them.",
            "Do not call gbrain high-level provider/LLM tools when the request says the runtime owns inference.",
            "Return ONLY the JSON result required by the operation. Do not add Markdown fences or commentary.",
            "For chat, return {text, blocks, stopReason, usage, model}; tool-call blocks use type=tool-call, toolCallId, toolName, input.",
            "For structured, return the object requested by payload.schema.",
            "For subagent, return {result, turns_count, stop_reason, tokens, artifacts?, writes?}.",
            "",
            json.dumps(envelope, ensure_ascii=False, separators=(",", ":")),
        ]
    )


def run_hermes(request: dict[str, Any]) -> tuple[int, str]:
    hermes = os.environ.get("GBRAIN_RUNTIME_HERMES_BIN") or shutil.which("hermes")
    if not hermes:
        return 127, ""

    with tempfile.TemporaryDirectory(prefix="gbrain-hermes-runtime-") as temp_dir:
        query_path = Path(temp_dir) / "query.txt"
        query_path.write_text(build_prompt(request), encoding="utf-8")
        command = [hermes, "chat", "--query-file", str(query_path), "--quiet", "--source", "tool"]
        configured_model = os.environ.get("GBRAIN_RUNTIME_HERMES_MODEL")
        if configured_model:
            command.extend(["--model", configured_model])
        configured_reasoning = os.environ.get("GBRAIN_RUNTIME_HERMES_REASONING")
        if configured_reasoning:
            command.extend(["--reasoning", configured_reasoning])
        configured_toolsets = os.environ.get("GBRAIN_RUNTIME_HERMES_TOOLSETS")
        if configured_toolsets:
            command.extend(["--toolsets", configured_toolsets])

        timeout_raw = os.environ.get("GBRAIN_RUNTIME_HERMES_TIMEOUT_SECONDS", "900")
        try:
            timeout_seconds = max(1, int(timeout_raw))
        except ValueError:
            timeout_seconds = 900
        try:
            result = subprocess.run(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=timeout_seconds,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return 124, ""
        return result.returncode, result.stdout


def run_capability_helper(request: dict[str, Any], operation: str) -> tuple[int, str]:
    """Run an optional provider-owning helper with the original request on stdin.

    Hermes' CLI is an agent/chat runtime and does not expose a stable embedding
    or reranker CLI. These optional helpers keep those provider calls outside
    GBrain while preserving the same runtime request contract. The helper must
    return the operation result only, not a second gbrain-runtime envelope.
    """
    command = _configured_command(operation)
    if command is None:
        return 127, ""
    try:
        timeout_raw = os.environ.get("GBRAIN_RUNTIME_HERMES_TIMEOUT_SECONDS", "900")
        try:
            timeout_seconds = max(1, int(timeout_raw))
        except ValueError:
            timeout_seconds = 900
        result = subprocess.run(
            command,
            input=json.dumps(request, ensure_ascii=False, separators=(",", ":")) + chr(10),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return 124, ""
    return result.returncode, result.stdout


def normalize_capability_result(value: Any, operation: str) -> Any | None:
    """Normalize helper output to the provider-neutral result shape."""
    if operation in {"embedding", "embedding_multimodal"}:
        if isinstance(value, list):
            return {"embeddings": value}
        if isinstance(value, dict) and isinstance(value.get("embeddings"), list):
            return value
        return None
    if operation == "reranker":
        if isinstance(value, list):
            return {"results": value}
        if isinstance(value, dict) and isinstance(value.get("results"), list):
            return value
        return None
    return value


def main() -> int:
    try:
        request = json.load(sys.stdin)
    except (JSONDecodeError, OSError):
        print(json.dumps({"protocol": PROTOCOL, "status": "failed", "error": {"code": "invalid_request", "message": "stdin is not one JSON object"}}))
        return 0

    if not isinstance(request, dict) or request.get("protocol") != PROTOCOL:
        print(json.dumps(response(request if isinstance(request, dict) else {}, "failed", code="protocol_mismatch", message="expected gbrain-runtime-v1")))
        return 0
    operation = request.get("operation")
    try:
        supported = supported_operations()
    except ValueError as exc:
        print(json.dumps(response(request, "failed", code="invalid_config", message=str(exc))))
        return 0
    if operation not in supported:
        print(json.dumps(response(request, "unsupported", code="capability_unavailable", message=f"Hermes bridge does not support {operation}")))
        return 0

    if operation in CAPABILITY_COMMAND_ENV:
        try:
            return_code, raw = run_capability_helper(request, operation)
        except ValueError as exc:
            print(json.dumps(response(request, "failed", code="invalid_config", message=str(exc))))
            return 0
        if return_code == 127:
            print(json.dumps(response(
                request,
                "failed",
                code="runtime_not_found",
                message=f"{operation} capability helper was not found",
            )))
            return 0
        if return_code == 124:
            print(json.dumps(response(
                request,
                "failed",
                code="runtime_timeout",
                message=f"{operation} capability helper timed out",
            )))
            return 0
        if return_code != 0:
            print(json.dumps(response(
                request,
                "failed",
                code="runtime_exit",
                message=f"{operation} capability helper exited with code {return_code}",
            )))
            return 0
        parsed = first_json_value(raw)
        result = normalize_capability_result(parsed, operation)
        if result is None:
            print(json.dumps(response(
                request,
                "failed",
                code="invalid_capability_result",
                message=f"{operation} capability helper returned an invalid result",
            )))
            return 0
        print(json.dumps(response(request, "completed", result=result), ensure_ascii=False, separators=(",", ":")))
        return 0

    return_code, raw = run_hermes(request)
    if return_code == 127:
        print(json.dumps(response(request, "failed", code="runtime_not_found", message="hermes executable was not found")))
        return 0
    if return_code != 0:
        print(json.dumps(response(request, "failed", code="runtime_exit", message=f"hermes exited with code {return_code}")))
        return 0

    parsed = first_json_value(raw)
    if operation == "structured":
        if not isinstance(parsed, dict):
            print(json.dumps(response(request, "failed", code="invalid_structured_result", message="Hermes did not return a JSON object")))
            return 0
        result: Any = parsed
    elif operation == "subagent":
        result = normalize_subagent(parsed, raw.strip())
    else:
        result = normalize_chat(parsed, raw.strip(), request.get("model"))

    print(json.dumps(response(request, "completed", result=result), ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
