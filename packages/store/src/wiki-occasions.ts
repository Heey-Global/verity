import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Database, WikiOccasionsTable } from './schema.js';

export type WikiOccasionKind = WikiOccasionsTable['kind'];

/** Text kept for one maintenance run is bounded; a longer one keeps its end. */
export const WIKI_OCCASION_BODY_LIMIT = 256 * 1024;

export interface WikiOccasion {
  id: string;
  projectId: string;
  kind: WikiOccasionKind;
  /** What the occasion is about: a knowledge path, a session id, a pull request URL. */
  ref: string;
  title: string;
  body: string | null;
  createdAt: string;
}

export interface RecordWikiOccasion {
  projectId: string;
  kind: WikiOccasionKind;
  ref: string;
  title: string;
  body?: string | undefined;
  /**
   * Open the occasion again when it was read already. A chat day that grows is
   * new material; a merge or a deleted session happens once and must not come
   * back when its signal repeats (a status cache refilled after a restart).
   */
  reopen?: boolean;
}

type Row = {
  id: string;
  project_id: string;
  kind: WikiOccasionKind;
  ref: string;
  title: string;
  body: string | null;
  created_at: Date;
};

const record = (row: Row): WikiOccasion => ({
  id: row.id,
  projectId: row.project_id,
  kind: row.kind,
  ref: row.ref,
  title: row.title,
  body: row.body,
  createdAt: row.created_at.toISOString(),
});

/** Keeps the end of a long text: the end of a conversation is where it settled. */
function bounded(body: string | undefined): string | null {
  if (body === undefined) return null;
  if (Buffer.byteLength(body) <= WIKI_OCCASION_BODY_LIMIT) return body;
  const tail = Buffer.from(body).subarray(-WIKI_OCCASION_BODY_LIMIT).toString('utf8');
  // A cut multi-byte character decodes as a replacement mark; drop it.
  return tail.replace(/^\uFFFD+/, '');
}

/** What happened in a project that its Wiki may need to reflect, until a run read it. */
export class WikiOccasionStore {
  constructor(private readonly db: Kysely<Database>) {}

  /** Records an occasion once per project, kind and ref. Returns whether it is open now. */
  async record(input: RecordWikiOccasion): Promise<boolean> {
    const body = bounded(input.body);
    const result = input.reopen
      ? await sql`insert into wiki_occasions(id,project_id,kind,ref,title,body)
          values(${randomUUID()},${input.projectId},${input.kind},${input.ref},${input.title},${body})
          on conflict(project_id,kind,ref) do update set title=excluded.title, body=excluded.body,
            created_at=now(), closed_at=null`.execute(this.db)
      : await sql`insert into wiki_occasions(id,project_id,kind,ref,title,body)
          values(${randomUUID()},${input.projectId},${input.kind},${input.ref},${input.title},${body})
          on conflict(project_id,kind,ref) do nothing`.execute(this.db);
    return Number(result.numAffectedRows ?? 0) > 0;
  }

  /** Open occasions of a project, oldest first. */
  async open(projectId: string, limit = 50): Promise<WikiOccasion[]> {
    const result = await sql<Row>`select id,project_id,kind,ref,title,body,created_at
      from wiki_occasions where project_id=${projectId} and closed_at is null
      order by created_at, id limit ${limit}`.execute(this.db);
    return result.rows.map(record);
  }

  /** How many occasions are open, and when the oldest and newest were recorded. */
  async pending(
    projectId: string,
  ): Promise<{ count: number; oldestAt: Date | null; newestAt: Date | null }> {
    const result = await sql<{
      count: string | number;
      oldest: Date | null;
      newest: Date | null;
    }>`select count(*) as count, min(created_at) as oldest, max(created_at) as newest
      from wiki_occasions where project_id=${projectId} and closed_at is null`.execute(this.db);
    const row = result.rows[0];
    return {
      count: Number(row?.count ?? 0),
      oldestAt: row?.oldest ?? null,
      newestAt: row?.newest ?? null,
    };
  }

  /** Drops open occasions recorded before `before`, kept text included. */
  async discardOpenBefore(projectId: string, before: Date): Promise<number> {
    const result = await sql`delete from wiki_occasions where project_id=${projectId}
      and closed_at is null and created_at < ${before}`.execute(this.db);
    return Number(result.numAffectedRows ?? 0);
  }

  /** One open occasion with its kept text. */
  async openOne(projectId: string, id: string): Promise<WikiOccasion | undefined> {
    const result = await sql<Row>`select id,project_id,kind,ref,title,body,created_at
      from wiki_occasions where project_id=${projectId} and id=${id}
        and closed_at is null`.execute(this.db);
    const row = result.rows[0];
    return row ? record(row) : undefined;
  }

  async countOpen(projectId: string): Promise<number> {
    const result = await sql<{ count: string | number }>`select count(*) as count
      from wiki_occasions where project_id=${projectId} and closed_at is null`.execute(this.db);
    return Number(result.rows[0]?.count ?? 0);
  }

  /** Projects with an open occasion recorded at or before `before`. */
  async projectsWithOpen(before: Date): Promise<string[]> {
    const result = await sql<{ project_id: string }>`select distinct project_id
      from wiki_occasions where closed_at is null and created_at <= ${before}
      order by project_id`.execute(this.db);
    return result.rows.map((row) => row.project_id);
  }

  /**
   * Marks occasions read and drops the text kept for the run. Only the version a
   * run read is closed: an occasion reopened meanwhile has a later `createdAt`
   * and stays open with its new text.
   */
  async close(
    projectId: string,
    read: readonly Pick<WikiOccasion, 'id' | 'createdAt'>[],
  ): Promise<number> {
    if (!read.length) return 0;
    const pairs = read.map(
      (occasion) => sql`(${occasion.id}, ${new Date(occasion.createdAt)}::timestamptz)`,
    );
    const result = await sql`update wiki_occasions set closed_at=now(), body=null
      where project_id=${projectId} and closed_at is null
        and (id, date_trunc('milliseconds', created_at)) in (${sql.join(pairs)})`.execute(this.db);
    return Number(result.numAffectedRows ?? 0);
  }

  /**
   * A session's conversation as plain text: the user's prompts and the agent's
   * replies, never tool output or notices. Kept for a maintenance run when a
   * session is deleted as done.
   */
  async sessionTranscript(sessionId: string): Promise<string> {
    // Only the end is kept, so only the end is read: a long session must not
    // load its whole history into memory on the deletion path.
    const result = await sql<{ role: 'user' | 'agent'; text: string }>`select role,text from (
        select role,text,first_event_seq,id,
          sum(octet_length(text)) over (order by first_event_seq desc, id desc) as total
        from messages where session_id=${sessionId} and kind in ('prompt','text')
      ) tail where total - octet_length(text) < ${WIKI_OCCASION_BODY_LIMIT}
      order by first_event_seq, id`.execute(this.db);
    return result.rows
      .map((row) => `${row.role === 'user' ? 'User' : 'Verity'}: ${row.text.trim()}`)
      .filter((line) => !/^(User|Verity): $/.test(line))
      .join('\n\n');
  }

  /** Forgets every occasion of a session, for a session deleted without Wiki review. */
  async forgetSession(projectId: string, sessionId: string): Promise<void> {
    await sql`delete from wiki_occasions where project_id=${projectId}
      and kind='session' and ref=${sessionId}`.execute(this.db);
  }
}

export interface WikiMaintenanceRecord {
  projectId: string;
  /** The quiet session runs happen in; null before the first run or after it was deleted. */
  sessionId: string | null;
  lastRunAt: Date | null;
}

/** Where and when each project's Wiki was last maintained. */
export class WikiMaintenanceStore {
  constructor(private readonly db: Kysely<Database>) {}

  async get(projectId: string): Promise<WikiMaintenanceRecord | undefined> {
    const result = await sql<{
      project_id: string;
      session_id: string | null;
      last_run_at: Date | null;
    }>`select project_id,session_id,last_run_at from wiki_maintenance
      where project_id=${projectId}`.execute(this.db);
    const row = result.rows[0];
    return row
      ? { projectId: row.project_id, sessionId: row.session_id, lastRunAt: row.last_run_at }
      : undefined;
  }

  /**
   * Claims a run at `at` unless one started after `notAfter`. Claiming before
   * any work means two server generations, or a crash mid-run, never start a
   * second run inside the minimum interval.
   */
  async claimRun(projectId: string, at: Date, notAfter: Date): Promise<boolean> {
    const result = await sql`insert into wiki_maintenance(project_id,last_run_at)
      values(${projectId},${at})
      on conflict(project_id) do update set last_run_at=excluded.last_run_at
      where wiki_maintenance.last_run_at is null
        or wiki_maintenance.last_run_at <= ${notAfter}`.execute(this.db);
    return Number(result.numAffectedRows ?? 0) > 0;
  }

  /** Gives back a claim whose run never started, so the next pass may try again. */
  async releaseRun(projectId: string, at: Date, previous: Date | null): Promise<void> {
    await sql`update wiki_maintenance set last_run_at=${previous}
      where project_id=${projectId} and last_run_at=${at}`.execute(this.db);
  }

  async setSession(projectId: string, sessionId: string): Promise<void> {
    await sql`insert into wiki_maintenance(project_id,session_id) values(${projectId},${sessionId})
      on conflict(project_id) do update set session_id=excluded.session_id`.execute(this.db);
  }

  /** Every maintenance session, so lists and notifications can leave them out. */
  async sessionIds(): Promise<Set<string>> {
    const result = await sql<{ session_id: string }>`select session_id from wiki_maintenance
      where session_id is not null`.execute(this.db);
    return new Set(result.rows.map((row) => row.session_id));
  }

  async isSession(sessionId: string): Promise<boolean> {
    const result = await sql`select 1 from wiki_maintenance
      where session_id=${sessionId}`.execute(this.db);
    return result.rows.length > 0;
  }
}
