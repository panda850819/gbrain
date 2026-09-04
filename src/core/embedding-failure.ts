import { embedBatchWithBackoff } from './embed-retry.ts';

export type EmbeddingDegradation = {
  status: 'degraded';
  error_code: 'embedding_failed';
  reason: 'quota_exhausted' | 'rate_limited' | 'authentication_failed' | 'provider_unavailable';
  message: string;
  suggestion: string;
  attempted_chunks: number;
};

export function classifyEmbeddingFailure(error: unknown): EmbeddingDegradation['reason'] {
  const message = error instanceof Error ? error.message : String(error);
  if (/credit|quota|billing|payment required/i.test(message)) return 'quota_exhausted';
  if (/429|rate.?limit|too many requests/i.test(message)) return 'rate_limited';
  if (/401|403|auth|api key|unauthor/i.test(message)) return 'authentication_failed';
  return 'provider_unavailable';
}

export async function embedBatchForImport(
  texts: string[],
): Promise<{ vectors: Float32Array[] } | { degradation: EmbeddingDegradation }> {
  try {
    const vectors = await embedBatchWithBackoff(texts);
    if (vectors.length !== texts.length) throw new Error('Embedding vector count mismatch.');
    return { vectors };
  } catch (error: unknown) {
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
