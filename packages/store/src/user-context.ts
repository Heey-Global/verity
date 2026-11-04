import type { Kysely } from 'kysely';
import type { Database } from './schema.js';

export const INSTRUCTIONS_MAX_CHARS = 12_000;
export const USER_MEMORY_MAX_CHARS = 8_000;
export interface UserContext {
  instructions: string;
  memory: string;
  revision: number;
}
export class ContextConflictError extends Error {}
export function validateContext(context: Pick<UserContext, 'instructions' | 'memory'>): void {
  if (
    context.instructions.length > INSTRUCTIONS_MAX_CHARS ||
    context.memory.length > USER_MEMORY_MAX_CHARS
  ) {
    throw new RangeError('Instructions or Memory exceeds its character limit');
  }
}

/** Personal context is keyed by authenticated identity, never a project or device. */
export class UserContextStore {
  constructor(private readonly db: Kysely<Database>) {}
  async read(userId: string): Promise<UserContext> {
    const row = await this.db
      .selectFrom('user_context')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row
      ? { instructions: row.instructions, memory: row.memory, revision: row.revision }
      : { instructions: '', memory: '', revision: 0 };
  }
  async appendMemory(userId: string, text: string): Promise<UserContext> {
    return this.db.transaction().execute(async (trx) => {
      const user = await trx
        .selectFrom('users')
        .select('id')
        .where('id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (!user) throw new Error('User not found');
      const current = await new UserContextStore(trx).read(userId);
      const addition = text.trim();
      if (!addition) return current;
      const next = {
        instructions: current.instructions,
        memory: [current.memory.trimEnd(), addition].filter(Boolean).join('\n'),
        revision: current.revision + 1,
      };
      validateContext(next);
      await trx
        .insertInto('user_context')
        .values({ user_id: userId, ...next })
        .onConflict((oc) => oc.column('user_id').doUpdateSet(next))
        .execute();
      return next;
    });
  }
  async replace(
    userId: string,
    expectedRevision: number,
    context: Pick<UserContext, 'instructions' | 'memory'>,
  ): Promise<UserContext> {
    validateContext(context);
    return this.db.transaction().execute(async (trx) => {
      // Serialize first creation and replacement on the existing identity row.
      const user = await trx
        .selectFrom('users')
        .select('id')
        .where('id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (!user) throw new Error('User not found');
      const store = new UserContextStore(trx);
      const current = await store.read(userId);
      if (current.revision !== expectedRevision)
        throw new ContextConflictError('Personal context changed; reload before saving');
      const next = { ...context, revision: current.revision + 1 };
      await trx
        .insertInto('user_context')
        .values({ user_id: userId, ...next })
        .onConflict((oc) => oc.column('user_id').doUpdateSet(next))
        .execute();
      return next;
    });
  }
}
