import type { BrainEngine } from '../engine.ts';
import type { ImportResult, ParsedPage } from '../import-file.ts';
import { OperationError } from '../ops/contract.ts';

/** Parsing/provider work is complete. apply must run under the coordinator's transaction. */
export interface PreparedContentImport {
  slug: string;
  parsedPage: ParsedPage;
  observedRevision: string | null;
  noop: boolean;
  result: ImportResult;
  /** Observable guardrail/audit effects, deferred until durable authorization. */
  beforePublication?: () => Promise<void>;
  /** A parsed ingest rejection that must settle only after deferred effects. */
  rejection?: { code: string; message: string };
  apply(tx: BrainEngine): Promise<void>;
}

export function preparedImportRejectionError(ready: Pick<PreparedContentImport, 'rejection'>): OperationError | null {
  return ready.rejection ? new OperationError(ready.rejection.code, ready.rejection.message) : null;
}
