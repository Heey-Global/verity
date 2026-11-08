/** A trusted Server installs this barrier before accepting destination changes.
 * The barrier must fence direct corridors before action, then synchronize the
 * committed authoritative snapshot before returning. It must never swallow errors.
 */
export type EgressDestinationMutation = <T>(
  action: () => Promise<T>,
  /** Evaluate inside the serialized destination transaction, before fencing. */
  changesDestinations?: () => Promise<boolean>,
) => Promise<T>;
export const unguardedEgressDestinationMutation: EgressDestinationMutation = (action) => action();

import { AsyncLocalStorage } from 'node:async_hooks';
import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';

const destinationTransactions = new AsyncLocalStorage<
  ReadonlyMap<Kysely<Database>, Kysely<Database>>
>();
export function egressDestinationDb(root: Kysely<Database>): Kysely<Database> {
  return destinationTransactions.getStore()?.get(root) ?? root;
}

/** The transaction owns source changes and the fencing ACK together. A crashed
 * Server cannot release its advisory lock before its source writes roll back.
 */
export function withEgressDestinationTransaction<T>(
  root: Kysely<Database>,
  action: () => Promise<T>,
): Promise<T> {
  if (destinationTransactions.getStore()?.has(root)) return action();
  return root.transaction().execute(async (transaction) => {
    await sql`set local lock_timeout = '5s'`.execute(transaction);
    await sql`select pg_advisory_xact_lock(1447383636, 1162302025)`.execute(transaction);
    const context = new Map(destinationTransactions.getStore());
    context.set(root, transaction);
    return destinationTransactions.run(context, action);
  });
}
