import { embedBatchWithBackoff } from './embed-retry.ts';

export type EmbeddingDegradation = {
  status: 'degraded';
  error_code: 'embedding_failed';
  reason: 'quota_exhausted' | 'provider_unavailable';
  message: string;
  suggestion: string;
};

function failureReason(error: unknown): EmbeddingDegradation['reason'] {
  const message = error instanceof Error ? error.message : String(error);
  return /credit|quota|billing|payment required/i.test(message)
    ? 'quota_exhausted'
    : 'provider_unavailable';
}

export async function embedBatchForImport(
  texts: string[],
): Promise<{ vectors: Float32Array[] } | { degradation: EmbeddingDegradation }> {
  try {
    const vectors = await embedBatchWithBackoff(texts);
    if (vectors.length !== texts.length) throw new Error('Embedding vector count mismatch.');
    return { vectors };
  } catch (error: unknown) {
    const reason = failureReason(error);
    return {
      degradation: {
        status: 'degraded',
        error_code: 'embedding_failed',
        reason,
        message: reason === 'quota_exhausted'
          ? 'Embedding provider quota is exhausted; page content was persisted without embeddings.'
          : 'Embedding provider was unavailable; page content was persisted without embeddings.',
        suggestion: 'Restore the embedding provider, then run `gbrain embed --stale` to backfill.',
      },
    };
  }
}
