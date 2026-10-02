/**
 * Embed one page's chunk texts with bounded per-chunk failure isolation.
 *
 * The batch-first path is cheap for the common case. Permanent request-shaped
 * failures may be isolated one chunk at a time; rate limits, network errors,
 * and authentication failures are rethrown instead of multiplying provider
 * traffic. Every attempt uses the shared embedding retry policy.
 */

import { AITransientError } from './ai/errors.ts';
import {
  embedBatchWithBackoff,
  isEmbedRetriableError,
  isTransientNetworkEmbedError,
  withEmbeddingRetryPolicy,
  type EmbedBatchWithBackoffOpts,
} from './embed-retry.ts';

/** Walk the cause chain for the first HTTP status. */
function statusFromCause(e: unknown): number | undefined {
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur !== undefined && cur !== null; depth++) {
    const obj = cur as { status?: unknown; statusCode?: unknown; cause?: unknown };
    if (typeof obj.status === 'number') return obj.status;
    if (typeof obj.statusCode === 'number') return obj.statusCode;
    cur = obj.cause;
  }
  return undefined;
}

/**
 * #3037: batch first, then isolate permanent request-shaped failures so one
 * bad chunk does not leave every sibling chunk NULL.
 */
export async function embedPageTexts(
  texts: string[],
  opts: EmbedBatchWithBackoffOpts = {},
): Promise<{ embeddings: (Float32Array | null)[]; failed: number; firstError?: unknown }> {
  const retryOpts = withEmbeddingRetryPolicy(opts);
  try {
    return { embeddings: await embedBatchWithBackoff(texts, retryOpts), failed: 0 };
  } catch (e: unknown) {
    if (opts.abortSignal?.aborted) throw e;
    if (texts.length <= 1) throw e;
    if (isEmbedRetriableError(e) || isTransientNetworkEmbedError(e) || e instanceof AITransientError) throw e;
    const status = statusFromCause(e);
    if (status === 401 || status === 403) throw e;

    const embeddings: (Float32Array | null)[] = [];
    let failed = 0;
    let firstError: unknown;
    for (const t of texts) {
      try {
        const single = await embedBatchWithBackoff([t], retryOpts);
        embeddings.push(single[0] ?? null);
        if (single[0] === undefined) { failed++; firstError ??= e; }
      } catch (chunkErr: unknown) {
        if (opts.abortSignal?.aborted) throw chunkErr;
        embeddings.push(null);
        failed++;
        firstError ??= chunkErr;
      }
    }
    if (failed === texts.length) throw firstError ?? e;
    return { embeddings, failed, firstError };
  }
}
