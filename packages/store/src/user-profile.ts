import type { Kysely } from 'kysely';
import type { Database } from './schema.js';

export const DISPLAY_NAME_MAX_CHARS = 80;

export interface UserProfile {
  userId: string;
  role: 'administrator' | 'member';
  displayName: string | null;
}

/**
 * Normalizes a display name or rejects it. A name is one line of visible text:
 * control characters and line separators would let a name forge extra lines in
 * a transcript or notification next to it.
 */
export function normalizeDisplayName(input: string): string {
  const name = input.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (name.length === 0 || [...name].length > DISPLAY_NAME_MAX_CHARS)
    throw new RangeError(`A display name has 1–${String(DISPLAY_NAME_MAX_CHARS)} characters`);
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(name))
    throw new RangeError('A display name cannot contain control or formatting characters');
  return name;
}

/** A person's own profile, keyed by authenticated identity, never a device. */
export class UserProfileStore {
  constructor(private readonly db: Kysely<Database>) {}

  async read(userId: string): Promise<UserProfile | undefined> {
    const row = await this.db
      .selectFrom('users')
      .select(['id', 'role', 'display_name'])
      .where('id', '=', userId)
      .executeTakeFirst();
    return row ? { userId: row.id, role: row.role, displayName: row.display_name } : undefined;
  }

  async setDisplayName(userId: string, input: string): Promise<UserProfile> {
    const displayName = normalizeDisplayName(input);
    const row = await this.db
      .updateTable('users')
      .set({ display_name: displayName })
      .where('id', '=', userId)
      .returning(['id', 'role', 'display_name'])
      .executeTakeFirst();
    if (!row) throw new Error('User not found');
    return { userId: row.id, role: row.role, displayName: row.display_name };
  }

  /** Names for a set of people, for labelling turn authors and members. */
  async displayNames(userIds: readonly string[]): Promise<Map<string, string | null>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.db
      .selectFrom('users')
      .select(['id', 'display_name'])
      .where('id', 'in', [...new Set(userIds)])
      .execute();
    return new Map(rows.map((row) => [row.id, row.display_name]));
  }
}
