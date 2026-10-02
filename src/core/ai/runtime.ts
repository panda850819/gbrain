/**
 * Provider-neutral external runtime protocol.
 *
 * GBrain owns phase semantics and persistence. A configured runtime owns model
 * inference and other provider-backed capabilities. The command adapter uses
 * stdin/stdout JSON and never invokes a cloud SDK itself.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const RUNTIME_PROTOCOL = 'gbrain-runtime-v1' as const;

export type RuntimeOperation =
  | 'chat'
  | 'structured'
  | 'subagent'
  | 'embedding'
  | 'embedding_multimodal'
  | 'reranker';

export type RuntimeCapability = RuntimeOperation;

export interface RuntimeConfig {
  /** Executable resolved by the host process. Spawned with shell=false. */
  command: string;
  /** Fixed argv passed to the runtime before the JSON request on stdin. */
  args?: string[];
  /** Capabilities the runtime promises to serve. Missing means chat only. */
  capabilities?: RuntimeCapability[];
  /** Wall-clock limit for one request. */
  timeout_ms?: number;
  /** Maximum stdout accepted from one request. */
  max_output_bytes?: number;
}

export interface RuntimeRequest extends RuntimeRequestMetadata {
  protocol: typeof RUNTIME_PROTOCOL;
  request_id: string;
  operation: RuntimeOperation;
  model?: string;
  payload: unknown;
}

export interface RuntimeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
}

export type RuntimeWriteMode = 'none' | 'proposal' | 'canonical';

export interface RuntimeWritePolicy {
  mode: RuntimeWriteMode;
  allow: string[];
}

export interface RuntimeRequestMetadata {
  run_id?: string;
  phase?: string;
  idempotency_key?: string;
  write_policy?: RuntimeWritePolicy;
  deadline_at_ms?: number;
}

export interface RuntimeResponse {
  protocol: typeof RUNTIME_PROTOCOL;
  request_id: string;
  operation: RuntimeOperation;
  status: 'completed' | 'unsupported' | 'failed';
  result?: unknown;
  usage?: RuntimeUsage;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
}

export interface RuntimeAdapter {
  readonly capabilities: ReadonlySet<RuntimeCapability>;
  invoke(request: RuntimeRequest, signal?: AbortSignal): Promise<RuntimeResponse>;
}

export class RuntimeError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code = 'runtime_error', retryable = false) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
    this.retryable = retryable;
  }
}

export class RuntimeCapabilityError extends RuntimeError {
  readonly operation: RuntimeOperation;

  constructor(operation: RuntimeOperation) {
    super(`Configured runtime does not support ${operation}.`, 'capability_unavailable', false);
    this.name = 'RuntimeCapabilityError';
    this.operation = operation;
  }
}

const DEFAULT_RUNTIME_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const ALL_CAPABILITIES: RuntimeCapability[] = [
  'chat',
  'structured',
  'subagent',
  'embedding',
  'embedding_multimodal',
  'reranker',
];

function isRuntimeCapability(value: unknown): value is RuntimeCapability {
  return typeof value === 'string' && ALL_CAPABILITIES.includes(value as RuntimeCapability);
}

export function normalizeRuntimeConfig(config: RuntimeConfig): Required<Pick<RuntimeConfig, 'command' | 'args' | 'capabilities' | 'timeout_ms' | 'max_output_bytes'>> {
  if (typeof config.command !== 'string' || config.command.trim() === '') {
    throw new RuntimeError('runtime.command must be a non-empty executable path or name.', 'invalid_config');
  }
  if (config.command.includes('\0')) {
    throw new RuntimeError('runtime.command cannot contain a NUL byte.', 'invalid_config');
  }

  const args = config.args ?? [];
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new RuntimeError('runtime.args must be an array of strings without NUL bytes.', 'invalid_config');
  }

  const capabilities = [...new Set((config.capabilities ?? ['chat']).filter(isRuntimeCapability))];
  if (capabilities.length === 0) {
    throw new RuntimeError(
      `runtime.capabilities must contain one of: ${ALL_CAPABILITIES.join(', ')}.`,
      'invalid_config',
    );
  }

  const timeoutMs = config.timeout_ms ?? DEFAULT_RUNTIME_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RuntimeError('runtime.timeout_ms must be a positive integer.', 'invalid_config');
  }

  const maxOutputBytes = config.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new RuntimeError('runtime.max_output_bytes must be a positive integer.', 'invalid_config');
  }

  return {
    command: config.command,
    args,
    capabilities,
    timeout_ms: timeoutMs,
    max_output_bytes: maxOutputBytes,
  };
}

export function makeRuntimeRequest(
  operation: RuntimeOperation,
  payload: unknown,
  model?: string,
  requestId: string = randomUUID(),
  metadata: RuntimeRequestMetadata = {},
): RuntimeRequest {
  return {
    protocol: RUNTIME_PROTOCOL,
    request_id: requestId,
    operation,
    ...(model ? { model } : {}),
    ...(metadata.run_id ? { run_id: metadata.run_id } : {}),
    ...(metadata.phase ? { phase: metadata.phase } : {}),
    ...(metadata.idempotency_key ? { idempotency_key: metadata.idempotency_key } : {}),
    ...(metadata.write_policy ? { write_policy: metadata.write_policy } : {}),
    ...(metadata.deadline_at_ms !== undefined ? { deadline_at_ms: metadata.deadline_at_ms } : {}),
    payload,
  };
}

function parseResponse(raw: string, request: RuntimeRequest): RuntimeResponse {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new RuntimeError(
      'Runtime returned invalid JSON on stdout.',
      'invalid_response',
      false,
    );
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeError('Runtime response must be a JSON object.', 'invalid_response', false);
  }
  const response = value as Partial<RuntimeResponse>;
  if (response.protocol !== RUNTIME_PROTOCOL) {
    throw new RuntimeError(
      `Runtime protocol mismatch: expected ${RUNTIME_PROTOCOL}.`,
      'protocol_mismatch',
      false,
    );
  }
  if (response.request_id !== request.request_id) {
    throw new RuntimeError('Runtime response request_id does not match the request.', 'request_id_mismatch', false);
  }
  if (response.operation !== request.operation) {
    throw new RuntimeError('Runtime response operation does not match the request.', 'operation_mismatch', false);
  }
  if (response.status !== 'completed' && response.status !== 'unsupported' && response.status !== 'failed') {
    throw new RuntimeError('Runtime response has an invalid status.', 'invalid_response', false);
  }
  if (response.status === 'failed' && (!response.error || typeof response.error.message !== 'string')) {
    throw new RuntimeError('Runtime failed response must include error.message.', 'invalid_response', false);
  }

  return response as RuntimeResponse;
}

const RUNTIME_ENV_KEYS = new Set([
  'HOME',
  'PATH',
  'PWD',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'CI',
  'NO_COLOR',
  'COLUMNS',
  'LINES',
  'PYTHONIOENCODING',
  'HERMES_HOME',
  'HERMES_PROFILE',
  'HERMES_CONFIG',
  'HERMES_ENV_FILE',
]);

/**
 * Keep provider credentials in the process that owns them. The runtime gets
 * host identity/configuration plus explicitly runtime-scoped variables, but
 * never inherits GBrain's OPENAI_API_KEY/ANTHROPIC_API_KEY/etc.
 */
function buildRuntimeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (RUNTIME_ENV_KEYS.has(key) || key.startsWith('LC_') || key.startsWith('XDG_') || key.startsWith('GBRAIN_RUNTIME_')) {
      env[key] = value;
    }
  }
  return env;
}

function killProcess(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // The close event will settle the request when the process is already gone.
  }
  const killTimer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill('SIGKILL');
    } catch {
      // Best effort only.
    }
  }, 2_000);
  killTimer.unref();
}

export class CommandRuntimeAdapter implements RuntimeAdapter {
  readonly capabilities: ReadonlySet<RuntimeCapability>;
  private readonly command: string;
  private readonly args: string[];
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(config: RuntimeConfig) {
    const normalized = normalizeRuntimeConfig(config);
    this.command = normalized.command;
    this.args = normalized.args;
    this.capabilities = new Set(normalized.capabilities);
    this.timeoutMs = normalized.timeout_ms;
    this.maxOutputBytes = normalized.max_output_bytes;
  }

  async invoke(request: RuntimeRequest, signal?: AbortSignal): Promise<RuntimeResponse> {
    if (!this.capabilities.has(request.operation)) {
      return {
        protocol: RUNTIME_PROTOCOL,
        request_id: request.request_id,
        operation: request.operation,
        status: 'unsupported',
        error: {
          code: 'capability_unavailable',
          message: `Configured runtime does not support ${request.operation}.`,
        },
      };
    }
    if (signal?.aborted) {
      throw new RuntimeError('Runtime request was aborted before start.', 'aborted', true);
    }

    let body: string;
    try {
      body = JSON.stringify(request);
    } catch {
      throw new RuntimeError('Runtime request payload is not JSON-serializable.', 'invalid_request', false);
    }

    const child = spawn(this.command, this.args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildRuntimeEnv(),
    });

    return await new Promise<RuntimeResponse>((resolve, reject) => {
      let settled = false;
      let stdout = '';
      let stdoutBytes = 0;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let abortHandler: (() => void) | undefined;

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
      };
      const finishError = (error: RuntimeError) => {
        if (settled) return;
        settled = true;
        cleanup();
        killProcess(child);
        reject(error);
      };
      const finishResponse = (response: RuntimeResponse) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(response);
      };

      timeout = setTimeout(() => {
        finishError(new RuntimeError('Runtime request timed out.', 'timeout', true));
      }, this.timeoutMs);

      abortHandler = () => finishError(new RuntimeError('Runtime request was aborted.', 'aborted', true));
      signal?.addEventListener('abort', abortHandler, { once: true });

      child.stdout.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        stdoutBytes += Buffer.byteLength(text, 'utf8');
        if (stdoutBytes > this.maxOutputBytes) {
          finishError(new RuntimeError('Runtime stdout exceeded the configured limit.', 'output_too_large', false));
          return;
        }
        stdout += text;
      });

      child.on('error', error => {
        finishError(new RuntimeError(`Could not start runtime command: ${error.message}`, 'spawn_error', true));
      });

      child.on('close', (code, signalCode) => {
        if (settled) return;
        if (code !== 0) {
          finishError(new RuntimeError(
            `Runtime command exited unsuccessfully${code === null ? ` with signal ${signalCode ?? 'unknown'}` : ` with code ${code}`}.`,
            'runtime_exit',
            code === null || code !== 0,
          ));
          return;
        }
        try {
          finishResponse(parseResponse(stdout.trim(), request));
        } catch (error) {
          finishError(error instanceof RuntimeError ? error : new RuntimeError(String(error), 'invalid_response', false));
        }
      });

      child.stdin.on('error', error => {
        finishError(new RuntimeError(`Could not write runtime request: ${error.message}`, 'stdin_error', true));
      });
      child.stdin.end(body + '\n');
    });
  }
}

export function runtimeResponseError(response: RuntimeResponse): RuntimeError | null {
  if (response.status !== 'failed') return null;
  return new RuntimeError(
    response.error?.message ?? 'Runtime reported a failed request.',
    response.error?.code ?? 'runtime_failed',
    response.error?.retryable === true,
  );
}

export function assertRuntimeCompleted(response: RuntimeResponse): asserts response is RuntimeResponse & { status: 'completed'; result: unknown } {
  if (response.status === 'unsupported') {
    throw new RuntimeCapabilityError(response.operation);
  }
  const error = runtimeResponseError(response);
  if (error) throw error;
  if (response.result === undefined) {
    throw new RuntimeError('Runtime completed without a result.', 'invalid_response', false);
  }
}
