import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';

export interface SandboxUpdateState {
  since: number;
  reasons: string[];
  reportedAt: number;
  recovery?: { state: 'checking' | 'ready' | 'failed'; at: number; detail: string };
}
/** Durable observations, never an authorization to replace a sandbox. */
export class SandboxUpdateStateStore {
  constructor(private readonly db: Kysely<Database>) {}
  async list(): Promise<Map<string, SandboxUpdateState>> {
    const result = await sql<{
      project_id: string;
      value: SandboxUpdateState;
    }>`select project_id,value from sandbox_update_state`.execute(this.db);
    return new Map(result.rows.map((row) => [row.project_id, row.value]));
  }
  async set(projectId: string, value: SandboxUpdateState): Promise<void> {
    await sql`insert into sandbox_update_state(project_id,value)
      select ${projectId},${JSON.stringify(value)}::jsonb where exists(select 1 from projects where id=${projectId})
      on conflict(project_id) do update set value=excluded.value`.execute(this.db);
  }
  async clear(projectId: string): Promise<void> {
    await sql`delete from sandbox_update_state where project_id=${projectId}`.execute(this.db);
  }
}
