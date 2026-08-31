# External Runtime

GBrain can delegate provider-backed work to an external runtime over a local
stdin/stdout protocol. GBrain keeps the phase semantics, brain state,
provenance, write policy, and result validation. The runtime owns model
inference and its credentials.

This is a provider boundary, not a new provider recipe. The runtime may be
Hermes, another agent runner, or a deterministic local process.

## Configure

Use the file plane so runtime command settings are available before the brain
engine connects:

```json
{
  "engine": "postgres",
  "runtime": {
    "command": "/absolute/path/to/gbrain-runtime",
    "args": ["--stdio"],
    "capabilities": ["chat", "structured", "subagent"],
    "timeout_ms": 300000,
    "max_output_bytes": 16777216
  }
}
```

The same settings can come from the process environment. Environment values
override the file value:

```bash
export GBRAIN_RUNTIME_COMMAND=/absolute/path/to/gbrain-runtime
export GBRAIN_RUNTIME_ARGS_JSON='["--stdio"]'
export GBRAIN_RUNTIME_CAPABILITIES=chat,structured,subagent
export GBRAIN_RUNTIME_TIMEOUT_MS=300000
export GBRAIN_RUNTIME_MAX_OUTPUT_BYTES=16777216
```

`command` is spawned with `shell=false`. Arguments are passed as an argv array;
there is no shell interpolation. Runtime credentials are not stored in GBrain
configuration and are owned by the runtime process.

When `capabilities` is omitted, the adapter advertises `chat` only. A missing
capability returns an explicit `unsupported` response and never falls back to a
GBrain provider.

### Split-host production topology

The command adapter is optional. If Hermes runs on a separate Mac mini and owns
the scheduled semantic workflow through remote personal-gbrain MCP, leave
`runtime.command` / `GBRAIN_RUNTIME_COMMAND` unset on the VPS. Keep GBrain's
mechanical autopilot running, disable native provider-backed semantic phases
that Hermes already owns (for example `cycle.propose_takes.enabled=false`), and
let the Mac runtime perform proposal reasoning and bounded writes through MCP.
This topology does not require a `hermes` executable inside the GBrain container.

Configure the command adapter only when a same-host runtime executable or a
purpose-built remote-runtime command is intentionally available to the worker.

## Wire protocol

The public TypeScript types are available from the package subpath:

```ts
import {
  RUNTIME_PROTOCOL,
  type RuntimeRequest,
  type RuntimeResponse,
} from 'gbrain/ai/runtime';
```

Every request is one JSON object followed by a newline:

```json
{
  "protocol": "gbrain-runtime-v1",
  "request_id": "uuid",
  "run_id": "cycle-uuid",
  "phase": "patterns",
  "idempotency_key": "dream:patterns:cycle-uuid",
  "operation": "subagent",
  "model": "anthropic:claude-sonnet-4-6",
  "write_policy": {
    "mode": "canonical",
    "allow": ["learnings/patterns/*"]
  },
  "deadline_at_ms": 1780000000000,
  "payload": {
    "prompt": "...",
    "system": "...",
    "max_turns": 30,
    "max_tokens": 8192,
    "tools": []
  }
}
```

The `model` field is a model intent. In external-runtime mode the runtime may
resolve it through its own model configuration; GBrain does not resolve it to a
vendor SDK or provider endpoint.

The runtime must emit exactly one JSON response on stdout. Logs belong on
stderr:

```json
{
  "protocol": "gbrain-runtime-v1",
  "request_id": "uuid",
  "operation": "subagent",
  "status": "completed",
  "usage": {
    "input_tokens": 100,
    "output_tokens": 50
  },
  "result": {
    "result": "...",
    "turns_count": 2,
    "stop_reason": "end_turn",
    "tokens": {
      "in": 100,
      "out": 50,
      "cache_read": 0,
      "cache_create": 0
    },
    "artifacts": ["reflections/dreams/example"],
    "writes": ["reflections/dreams/example"]
  }
}
```

Allowed response statuses:

- `completed` — `result` is present and is validated by the operation caller.
- `unsupported` — the runtime does not implement the requested capability.
- `failed` — `error.code`, `error.message`, and optional `error.retryable` explain
  the failure.

Mismatched protocol, request ID, operation, missing result, malformed JSON, and
oversized stdout fail closed.

## Operations

| Operation | Runtime result | Used by |
|---|---|---|
| `chat` | provider-neutral `ChatResult` with text/tool-call blocks | gateway chat, facts, judges, tool loop |
| `structured` | JSON object matching the supplied schema | query expansion and structured judges |
| `subagent` | `SubagentResult` plus optional artifacts/write receipt | dream subagent phases |
| `embedding` | `{ embeddings: number[][] }` | embedding/import/search paths |
| `embedding_multimodal` | `{ embeddings: number[][] }` | image/text embedding paths |
| `reranker` | `{ results: [{ index, relevanceScore }] }` | search reranking |

A runtime that supports `subagent` owns the full agent/tool loop. A runtime
that supports only `chat` lets GBrain retain its existing provider-neutral
`toolLoop` and delegates each model turn.

## Hermes adapter

The repository includes a reference adapter:

```text
scripts/runtime/hermes-runtime.py
```

It invokes the installed Hermes CLI with a temporary query file:

```text
hermes chat --query-file <temporary-file> --quiet --source tool
```

Hermes owns its own model and authentication configuration. Optional runtime
environment settings are:

```bash
GBRAIN_RUNTIME_HERMES_BIN=/absolute/path/to/hermes
GBRAIN_RUNTIME_HERMES_MODEL=<hermes-model>
GBRAIN_RUNTIME_HERMES_REASONING=<reasoning-level>
GBRAIN_RUNTIME_HERMES_TOOLSETS=<comma-separated-toolsets>
GBRAIN_RUNTIME_HERMES_TIMEOUT_SECONDS=900
```

The bridge keeps diagnostics off stdout so GBrain can parse one response. It
uses Hermes' configured tools for `subagent` work and returns a structured
receipt to GBrain.

## Phase and write policy

Dream phases should forward a phase-level metadata object:

```ts
{
  run_id,
  phase,
  idempotency_key,
  write_policy: {
    mode: 'none' | 'proposal' | 'canonical',
    allow: string[],
  },
  deadline_at_ms,
}
```

The runtime must treat `write_policy` as a hard boundary. GBrain accepts the
runtime result only after its normal phase and write validation. A proposal
runtime should use:

```json
{
  "mode": "proposal",
  "allow": ["reflections/dreams/*"]
}
```

Promotion into canonical knowledge remains a separate operation.

For whole-subagent results, GBrain treats `writes` as a receipt claim only after
checking every slug against `write_policy.allow` and reading each reported page
back from the same source. A missing or out-of-policy write fails the job.

## Failure and replay

The runtime adapter gives each request a timeout and abort signal. The external
runtime should make writes idempotent using the supplied `idempotency_key`.
When a worker retries a phase, the same phase contract and idempotency key must
not produce a duplicate page or duplicate side effect.

The cycle coordinator remains responsible for phase ordering and the final
`CycleReport`. The runtime is not allowed to claim a phase completed merely
because its process exited zero; GBrain validates the response envelope and
result shape first.

## Test contract

The adapter test suite uses a real child process and covers:

- request/response round-trip;
- protocol, request ID, and operation validation;
- capability absence;
- timeout termination;
- oversized/malformed responses;
- chat, structured, embedding, and reranker routing;
- embedding result count, input order, finite values, and configured dimensions;
- whole-subagent write receipts against the allow-list and page read-back;
- whole-subagent routing without an Anthropic API key.

Run the focused tests with:

```bash
bun test test/ai/runtime.test.ts test/runtime-hermes-bridge.test.ts test/runtime-subagent.test.ts
bun run typecheck
```
