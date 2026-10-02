/**
 * Source-owned filing policy for untrusted page writes.
 *
 * A source may carry its own machine-readable filing contract at
 * `<local_path>/skills/_brain-filing-rules.json`.  The policy is deliberately
 * resolved from the target source row, never from this checkout's bundled
 * skills directory: a multi-source brain can mount repositories with
 * different filing vocabularies.
 */

import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from './engine.ts';
import { OperationError } from './ops/contract.ts';
import type { OperationContext } from './ops/contract.ts';

const POLICY_RELATIVE_PATH = join('skills', '_brain-filing-rules.json');
const POLICY_HINT =
  'Use a declared `rules[].directory` prefix. For recovery, have a trusted local writer place the item under `inbox/` and then file it correctly.';

/** The normalized subset of the source policy used by remote put_page. */
export interface SourceFilingPolicy {
  readonly directories: readonly string[];
  /** Undefined means the policy did not declare a topic allow-list. */
  readonly allowedTopicDomains?: readonly string[];
}

class MalformedSourceFilingPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedSourceFilingPolicyError';
  }
}

class SourceFilingPolicyResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceFilingPolicyResolutionError';
  }
}

/**
 * Parse and strictly validate the policy fields used by the write gate.
 * Unknown fields remain forward-compatible, but a field the gate consumes is
 * never accepted with a loose/coerced shape. Invalid policy data therefore
 * cannot accidentally turn the gate into an allow-all.
 */
export function parseSourceFilingPolicy(raw: unknown): SourceFilingPolicy {
  if (!isRecord(raw)) {
    throw new MalformedSourceFilingPolicyError('top-level must be an object');
  }
  if (!Array.isArray(raw.rules)) {
    throw new MalformedSourceFilingPolicyError('"rules" must be an array');
  }

  const directories: string[] = [];
  for (const [index, rule] of raw.rules.entries()) {
    if (!isRecord(rule)) {
      throw new MalformedSourceFilingPolicyError(`rules[${index}] must be an object`);
    }
    directories.push(normalizeDirectory(rule.directory, `rules[${index}].directory`));
  }

  let allowedTopicDomains: string[] | undefined;
  if (Object.prototype.hasOwnProperty.call(raw, 'topic_domains')) {
    if (!isRecord(raw.topic_domains) || !Array.isArray(raw.topic_domains.allowed)) {
      throw new MalformedSourceFilingPolicyError('"topic_domains.allowed" must be an array');
    }
    allowedTopicDomains = raw.topic_domains.allowed.map((domain, index) =>
      normalizeSegment(domain, `topic_domains.allowed[${index}]`),
    );
  }

  // A top-level topics/ rule without an explicit allow-list would make the
  // policy's advertised topic boundary ambiguous. Fail closed at load time.
  if (directories.includes('topics/') && allowedTopicDomains === undefined) {
    throw new MalformedSourceFilingPolicyError(
      'a topics/ rule requires topic_domains.allowed',
    );
  }

  return {
    directories: [...new Set(directories)],
    ...(allowedTopicDomains !== undefined
      ? { allowedTopicDomains: [...new Set(allowedTopicDomains)] }
      : {}),
  };
}

/**
 * Resolve a source's policy. A verified readable source checkout with no
 * policy leaf is represented as null for backwards compatibility. A source
 * lookup/check-out failure, or a policy that exists but cannot be parsed, is
 * thrown so the caller can fail closed. A pathless source remains a legacy
 * DB-only source with no filesystem policy to enforce.
 */
export async function loadSourceFilingPolicy(
  engine: Pick<BrainEngine, 'executeRaw'>,
  sourceId: string,
): Promise<SourceFilingPolicy | null> {
  // The BrainEngine contract always exposes executeRaw. If a test double or
  // degraded caller violates that contract, it cannot prove policy absence;
  // fail closed rather than turning the missing lookup into allow-all.
  if (typeof engine.executeRaw !== 'function') {
    throw new SourceFilingPolicyResolutionError('source lookup is unavailable');
  }

  let rows: Array<{ local_path: string | null }>;
  try {
    rows = await engine.executeRaw<{ local_path: string | null }>(
      'SELECT local_path FROM sources WHERE id = $1',
      [sourceId],
    );
  } catch (error) {
    // A source lookup failure cannot prove that a policy is absent. Real
    // engines fail closed rather than allowing a transient DB error to turn
    // an opted-in source into an allow-all source.
    throw new SourceFilingPolicyResolutionError(
      error instanceof Error ? error.message : String(error),
    );
  }

  if (!Array.isArray(rows)) {
    throw new SourceFilingPolicyResolutionError('source lookup returned an invalid result');
  }
  if (rows.length === 0) {
    throw new SourceFilingPolicyResolutionError('source was not found');
  }
  if (rows.length !== 1) {
    throw new SourceFilingPolicyResolutionError('source lookup returned multiple rows');
  }
  const row = rows[0];
  if (!isRecord(row) || !Object.prototype.hasOwnProperty.call(row, 'local_path')) {
    throw new SourceFilingPolicyResolutionError('source lookup returned an invalid row');
  }
  const localPath = row.local_path;
  if (localPath === null || localPath === '') return null;
  if (typeof localPath !== 'string') {
    throw new SourceFilingPolicyResolutionError('source local_path is invalid');
  }

  // A missing source checkout is not equivalent to a source that never opted
  // into the gate. Prove the checkout itself is readable before treating an
  // ENOENT on the policy leaf as the legacy, no-policy case. The `skills/`
  // parent is optional for legacy repositories, so its absence must flow
  // through the same missing-policy compatibility path.
  if (!isReadableDirectory(localPath)) {
    throw new SourceFilingPolicyResolutionError('source checkout is missing or unreadable');
  }

  const policyPath = join(localPath, POLICY_RELATIVE_PATH);
  let content: string;
  try {
    content = readFileSync(policyPath, 'utf8');
  } catch (error) {
    // ENOENT means the verified source checkout simply has no policy file,
    // including a legacy checkout with no `skills/` parent. Recheck the root
    // so a checkout removed during this read cannot become an allow-all. Every
    // other read failure means an opted-in policy cannot be trusted, so fail
    // closed.
    if (isErrno(error, 'ENOENT')) {
      if (isReadableDirectory(localPath)) return null;
      throw new SourceFilingPolicyResolutionError('source checkout disappeared while loading policy');
    }
    throw new MalformedSourceFilingPolicyError('policy file is unreadable');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new MalformedSourceFilingPolicyError('policy file is not valid JSON');
  }
  return parseSourceFilingPolicy(parsed);
}

/**
 * Return the reason a slug is outside a normalized policy, or null when it is
 * admissible.  This is pure so path-boundary behavior can be pinned without
 * touching a database or filesystem.
 */
export function filingPolicyRejectionReason(
  slug: string,
  policy: SourceFilingPolicy,
): 'bare_root' | 'wiki_namespace' | 'raw_path' | 'undeclared_directory' | 'topic_domain' | null {
  // importFromContent applies the same lowercasing at its write boundary;
  // policy decisions must cover that effective slug (including `.RAW`).
  const normalizedSlug = slug.toLowerCase();
  if (!normalizedSlug.includes('/')) return 'bare_root';
  if (normalizedSlug.startsWith('wiki/')) return 'wiki_namespace';

  const segments = normalizedSlug.split('/');
  // Raw sidecars are conventionally `<page-slug>.raw/`; a literal `.raw`
  // segment is rejected too (validatePageSlug normally catches that earlier).
  if (segments.some((segment) => segment === '.raw' || segment.endsWith('.raw'))) return 'raw_path';

  if (!policy.directories.some((directory) => normalizedSlug.startsWith(directory))) {
    return 'undeclared_directory';
  }

  if (normalizedSlug.startsWith('topics/')) {
    const domain = segments[1];
    if (!domain || !policy.allowedTopicDomains?.includes(domain)) {
      return 'topic_domain';
    }
  }

  return null;
}

/**
 * Enforce the source policy for the remote/untrusted put_page path. The
 * trusted local CLI is intentionally untouched, including when its source
 * policy is malformed; existing subagent and OAuth fences run before this
 * helper at the operation seam.
 */
export async function enforceRemoteFilingPolicy(
  ctx: OperationContext,
  slug: string,
): Promise<void> {
  if (ctx.remote === false) return;
  // Subagent writes already have a stricter caller-owned namespace fence (or
  // the protected trusted-workspace allow-list) immediately before this gate.
  // Keep that established contract intact: the source policy targets ordinary
  // remote MCP writers, while subagent paths remain governed by their own
  // protected fence and do not get rejected merely because they use `wiki/`.
  if (ctx.viaSubagent === true) return;

  let policy: SourceFilingPolicy | null;
  try {
    policy = await loadSourceFilingPolicy(ctx.engine, ctx.sourceId);
  } catch (error) {
    if (error instanceof MalformedSourceFilingPolicyError) {
      throw new OperationError(
        'invalid_params',
        'put_page: the source filing policy is malformed; remote writes are disabled until it is fixed.',
        POLICY_HINT,
      );
    }
    if (error instanceof SourceFilingPolicyResolutionError) {
      throw new OperationError(
        'invalid_params',
        'put_page: the source filing policy could not be loaded; remote writes are disabled until it can be read.',
        POLICY_HINT,
      );
    }
    throw error;
  }
  if (!policy) return;

  const reason = filingPolicyRejectionReason(slug, policy);
  if (!reason) return;

  throw new OperationError(
    'invalid_params',
    `put_page: remote slug rejected by the source filing policy (${reason}).`,
    POLICY_HINT,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeDirectory(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new MalformedSourceFilingPolicyError(`${field} must be a non-empty path`);
  }
  if (value.startsWith('/') || value.includes('\\')) {
    throw new MalformedSourceFilingPolicyError(`${field} must be a relative path`);
  }
  // A source policy may intentionally declare the root raw-data namespace,
  // but filingPolicyRejectionReason rejects every slug under it as raw_path.
  // Keep this exception literal so other hidden directories stay malformed.
  if (value === '.raw/') return value;

  const withoutTrailingSlash = value.endsWith('/') ? value.slice(0, -1) : value;
  if (withoutTrailingSlash.length === 0 || withoutTrailingSlash.endsWith('/')) {
    throw new MalformedSourceFilingPolicyError(`${field} has an empty path segment`);
  }
  const segments = withoutTrailingSlash.split('/');
  if (segments.some((segment) => !isValidSegment(segment))) {
    throw new MalformedSourceFilingPolicyError(`${field} has an invalid path segment`);
  }
  return `${segments.join('/').toLowerCase()}/`;
}

function normalizeSegment(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isValidSegment(value)) {
    throw new MalformedSourceFilingPolicyError(`${field} must be one path segment`);
  }
  return value.toLowerCase();
}

function isValidSegment(segment: string): boolean {
  return /^[\p{L}\p{N}_][\p{L}\p{N}._-]*$/u.test(segment);
}

function isReadableDirectory(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
    accessSync(path, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === code,
  );
}
