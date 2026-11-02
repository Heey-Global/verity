import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';

/** What the assistant may do in a project: nothing, file tasks, or also hand off work to sessions. */
export type AssistantMode = 'off' | 'tasks' | 'delegate';

export interface AssistantSettings {
  enabled: boolean;
  revision: number;
  sponsor_user_id: string | null;
  session_id: string | null;
}

export interface AssistantGrant {
  project_id: string;
  mode: AssistantMode;
  sponsor_user_id: string;
  revision: number;
}

/** The installation-wide assistant: one Verity Control session plus per-project grants. */
export class AssistantStore {
  constructor(private readonly db: Kysely<Database>) {}

  async settings(): Promise<AssistantSettings> {
    const row = (
      await sql<AssistantSettings>`select enabled, revision, sponsor_user_id, session_id from assistant_settings where id = 1`.execute(
        this.db,
      )
    ).rows[0];
    return row ?? { enabled: false, revision: 0, sponsor_user_id: null, session_id: null };
  }

  async configure(enabled: boolean, sponsor: string): Promise<void> {
    await sql`insert into assistant_settings(id, enabled, sponsor_user_id, revision) values (1, ${enabled}, ${sponsor}, 1) on conflict (id) do update set enabled = excluded.enabled, sponsor_user_id = case when excluded.enabled then excluded.sponsor_user_id else assistant_settings.sponsor_user_id end, revision = assistant_settings.revision + 1, updated_at = now()`.execute(
      this.db,
    );
  }

  /** Records the assistant session once; concurrent callers all get the first id. */
  async session(candidate: string): Promise<string> {
    const row = (
      await sql<{
        session_id: string;
      }>`update assistant_settings set session_id = coalesce(session_id, ${candidate}) where id = 1 returning session_id`.execute(
        this.db,
      )
    ).rows[0];
    if (!row) throw new Error('The assistant is not configured');
    return row.session_id;
  }

  /** Swaps a stale session id for a fresh one; returns whichever id is stored afterwards. */
  async replaceSession(stale: string, candidate: string): Promise<string> {
    const row = (
      await sql<{
        session_id: string;
      }>`update assistant_settings set session_id = ${candidate} where id = 1 and session_id = ${stale} returning session_id`.execute(
        this.db,
      )
    ).rows[0];
    return row?.session_id ?? (await this.session(candidate));
  }

  async grants(): Promise<AssistantGrant[]> {
    return (
      await sql<AssistantGrant>`select project_id, mode, sponsor_user_id, revision from assistant_project_grants order by project_id`.execute(
        this.db,
      )
    ).rows;
  }

  async grant(projectId: string): Promise<AssistantGrant | undefined> {
    return (
      await sql<AssistantGrant>`select project_id, mode, sponsor_user_id, revision from assistant_project_grants where project_id = ${projectId}`.execute(
        this.db,
      )
    ).rows[0];
  }

  async setGrant(projectId: string, sponsor: string, mode: AssistantMode): Promise<void> {
    await sql`insert into assistant_project_grants (project_id, sponsor_user_id, mode) values (${projectId}, ${sponsor}, ${mode}) on conflict (project_id) do update set mode = excluded.mode, sponsor_user_id = excluded.sponsor_user_id, revision = assistant_project_grants.revision + 1, updated_at = now()`.execute(
      this.db,
    );
  }
}
