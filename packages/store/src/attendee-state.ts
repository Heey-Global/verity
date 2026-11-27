import { sql, type Kysely } from 'kysely';
import type { SecretCipher } from './crypto.js';
import type { Database } from './schema.js';

export class AttendeeStateStore {
  constructor(
    private readonly getDb: () => Kysely<Database>,
    private readonly getCipher: () => SecretCipher,
  ) {}

  async getAttendeeState<T>(id: string): Promise<T | undefined> {
    const result = await sql<{
      state_secret: string;
    }>`select state_secret from attendee_state where id = ${id}`.execute(this.getDb());
    const row = result.rows[0];
    return row ? (JSON.parse(this.getCipher().decrypt(row.state_secret)) as T) : undefined;
  }

  async putAttendeeState(id: string, state: unknown): Promise<void> {
    const encrypted = this.getCipher().encrypt(JSON.stringify(state));
    await sql`insert into attendee_state (id, state_secret) values (${id}, ${encrypted}) on conflict (id) do update set state_secret = excluded.state_secret`.execute(
      this.getDb(),
    );
  }

  async listAttendeeState<T>(): Promise<Array<{ id: string; state: T }>> {
    const result = await sql<{
      id: string;
      state_secret: string;
    }>`select id, state_secret from attendee_state where id <> 'config'`.execute(this.getDb());
    return result.rows.map((row) => ({
      id: row.id,
      state: JSON.parse(this.getCipher().decrypt(row.state_secret)) as T,
    }));
  }

  async deleteAttendeeState(id: string): Promise<void> {
    await sql`delete from attendee_state where id = ${id}`.execute(this.getDb());
  }
}
