import type { BrainEngine } from '../engine.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { assertPersistenceAccepting } from './service.ts';
import { authorizeWrite, submissionAuthority } from './authority.ts';
import { authorizePageVisibility } from './page-visibility.ts';
import { managedPersistenceEnabled } from './ownership.ts';
import { initializeLocalPersistence } from './page-mutations.ts';
import { withCoordinatedWrite } from './context.ts';

/**
 * Managed add_link is a database-only coordinated write, without a file or
 * receipt. Source and durable grant locks precede stable endpoint page guards,
 * matching publication lock order. Recheck both endpoints' visibility after
 * those guards: an earlier submission/preflight cannot authorize a page that
 * became private while the transaction was starting or waiting for locks.
 * Returns null on an unmanaged brain; the caller keeps its legacy path.
 */
export async function coordinatedManualLinkWrite<T>(ctx: OperationContext, operation: 'add_link',
  from: string, to: string, write: (engine: BrainEngine, sourceId: string) => Promise<T>): Promise<{ value: T } | null> {
  if (!await managedPersistenceEnabled(ctx.engine)) return null;
  assertPersistenceAccepting(ctx.engine);
  const sourceId = ctx.sourceId ?? 'default';
  const [source] = await ctx.engine.executeRaw<{ incarnation: string; archived: boolean }>(
    'SELECT incarnation,archived FROM sources WHERE id=$1', [sourceId]);
  if (!source || source.archived) throw new OperationError('source_changed', 'The link source is not active.');
  await initializeLocalPersistence(ctx);
  const authority = await submissionAuthority(ctx, operation, sourceId, source.incarnation, from);
  const value = await ctx.engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
    const [current] = await tx.executeRaw<{ incarnation: string; archived: boolean }>(
      'SELECT incarnation,archived FROM sources WHERE id=$1 FOR SHARE', [sourceId]);
    if (!current || current.archived || current.incarnation !== source.incarnation) {
      throw new OperationError('source_changed', 'The link source changed before the write.');
    }
    await authorizeWrite(tx, authority, operation, from, true);
    await tx.lockPageKeys([{ sourceId, slug: from }, { sourceId, slug: to }]);
    await authorizeWrite(tx, authority, operation, from, true);
    await authorizePageVisibility(tx, authority, from);
    await authorizePageVisibility(tx, authority, to);
    return write(tx, sourceId);
  }));
  return { value };
}
