import {
  classifyEmbeddingFailure,
  embedBatchWithBackoff,
  withEmbeddingRetryPolicy,
  type EmbeddingFailureReason,
} from './embed-retry.ts';

export {
  classifyEmbeddingFailure,
  shouldRetryEmbeddingFailure,
  withEmbeddingRetryPolicy,
} from './embed-retry.ts';

export type EmbeddingDegradation = {
  status: 'degraded';
  error_code: 'embedding_failed';
  reason: EmbeddingFailureReason;
  message: string;
  suggestion: string;
  attempted_chunks: number;
};

export async function embedBatchForImport(
  texts: string[],
  opts: { abortSignal?: AbortSignal } = {},
): Promise<{ vectors: Float32Array[] } | { degradation: EmbeddingDegradation }> {
  try {
    const vectors = await embedBatchWithBackoff(texts, withEmbeddingRetryPolicy({ abortSignal: opts.abortSignal }));
    if (vectors.length !== texts.length) throw new Error('Embedding vector count mismatch.');
    return { vectors };
  } catch (error: unknown) {
    if (opts.abortSignal?.aborted) throw error;
    const reason = classifyEmbeddingFailure(error);
    return {
      degradation: {
        status: 'degraded',
        error_code: 'embedding_failed',
        reason,
        message: `Embedding provider ${reason.replaceAll('_', ' ')}; page content was persisted without embeddings.`,
        suggestion: 'Restore the embedding provider, then run `gbrain embed --stale` to backfill.',
        attempted_chunks: texts.length,
      },
    };
  }
}
