import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';

export interface ProjectInquiryGrant {
  sourceProjectId: string;
  targetProjectId: string;
  enabled: boolean;
  createdAt: string;
}
export type ProjectInquiryStatus =
  'pending' | 'approved' | 'rejected' | 'queued' | 'answered' | 'blocked';
export interface ProjectInquiry {
  id: string;
  sourceSessionId: string;
  targetSessionId: string;
  sourceProjectId: string;
  targetProjectId: string;
  title: string;
  body: string;
  kind: 'question' | 'change';
  status: ProjectInquiryStatus;
  createdAt: string;
  answer: string | null;
  userId: string | null;
  decidedBy: string | null;
}
type Row = {
  id: string;
  source_session_id: string;
  target_session_id: string;
  source_project_id: string;
  target_project_id: string;
  title: string;
  body: string;
  kind: ProjectInquiry['kind'];
  status: ProjectInquiryStatus;
  created_at: Date;
  answer: string | null;
  user_id: string | null;
  decided_by: string | null;
};
const record = (r: Row): ProjectInquiry => ({
  id: r.id,
  sourceSessionId: r.source_session_id,
  targetSessionId: r.target_session_id,
  sourceProjectId: r.source_project_id,
  targetProjectId: r.target_project_id,
  title: r.title,
  body: r.body,
  kind: r.kind,
  status: r.status,
  createdAt: r.created_at.toISOString(),
  answer: r.answer,
  userId: r.user_id,
  decidedBy: r.decided_by,
});

/** Durable project-to-project requests; a peer can never write the human decision. */
export class ProjectInquiryStore {
  constructor(private readonly db: Kysely<Database>) {}

  async grants(sourceProjectId: string): Promise<ProjectInquiryGrant[]> {
    const result = await sql<{
      source_project_id: string;
      target_project_id: string;
      enabled: boolean;
      created_at: Date;
    }>`select * from project_inquiry_grants where source_project_id=${sourceProjectId}
      order by target_project_id`.execute(this.db);
    return result.rows.map((r) => ({
      sourceProjectId: r.source_project_id,
      targetProjectId: r.target_project_id,
      enabled: r.enabled,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async setGrant(source: string, target: string, enabled: boolean): Promise<void> {
    if (source === target) throw new Error('Choose a different target project');
    await this.db.transaction().execute(async (tx) => {
      await sql`insert into project_inquiry_grants(source_project_id,target_project_id,enabled)
        values(${source},${target},${enabled}) on conflict(source_project_id,target_project_id)
        do update set enabled=excluded.enabled`.execute(tx);
      if (!enabled)
        await sql`update project_inquiries set status='blocked'
          where source_project_id=${source} and target_project_id=${target}
            and status in ('pending','approved')`.execute(tx);
    });
  }

  async allowed(source: string, target: string): Promise<boolean> {
    return (
      (
        await sql`select 1 from project_inquiry_grants where source_project_id=${source}
        and target_project_id=${target} and enabled`.execute(this.db)
      ).rows.length > 0
    );
  }

  async isTarget(sessionId: string): Promise<boolean> {
    return (
      (
        await sql`select 1 from project_inquiry_sessions where target_session_id=${sessionId}`.execute(
          this.db,
        )
      ).rows.length > 0
    );
  }

  /** The most recently admitted request controls the reusable target's posture. */
  async activate(id: string): Promise<void> {
    await sql`update project_inquiry_sessions s set change_approved=(i.kind='change')
      from project_inquiries i where i.id=${id} and i.status='approved'
      and s.target_session_id=i.target_session_id`.execute(this.db);
  }

  async isReadOnlyTarget(sessionId: string): Promise<boolean> {
    return (
      (
        await sql`select 1 from project_inquiry_sessions
        where target_session_id=${sessionId} and not change_approved`.execute(this.db)
      ).rows.length > 0
    );
  }

  async bind(
    sourceSessionId: string,
    targetProjectId: string,
    targetSessionId: string,
  ): Promise<void> {
    await sql`insert into project_inquiry_sessions(source_session_id,target_project_id,target_session_id)
      values(${sourceSessionId},${targetProjectId},${targetSessionId})
      on conflict(source_session_id,target_project_id) do nothing`.execute(this.db);
  }

  async target(sourceSessionId: string, targetProjectId: string): Promise<string | undefined> {
    return (
      await sql<{
        target_session_id: string;
      }>`select target_session_id from project_inquiry_sessions
        where source_session_id=${sourceSessionId} and target_project_id=${targetProjectId}`.execute(
        this.db,
      )
    ).rows[0]?.target_session_id;
  }

  async get(id: string): Promise<ProjectInquiry | undefined> {
    const row = (await sql<Row>`select * from project_inquiries where id=${id}`.execute(this.db))
      .rows[0];
    return row ? record(row) : undefined;
  }

  async list(
    sessionId?: string,
    pending = false,
    targetProjectIds?: readonly string[],
  ): Promise<ProjectInquiry[]> {
    const rows = await sql<Row>`select * from project_inquiries
      where (${sessionId ?? null}::text is null or source_session_id=${sessionId ?? null}
        or target_session_id=${sessionId ?? null})
      and (${!pending} or status='pending')
      and (${targetProjectIds === undefined} or target_project_id in (select jsonb_array_elements_text(${JSON.stringify(targetProjectIds ?? [])}::jsonb)))
      order by created_at desc limit 200`.execute(this.db);
    return rows.rows.map(record);
  }

  async create(
    input: Omit<ProjectInquiry, 'createdAt' | 'answer' | 'decidedBy'>,
  ): Promise<ProjectInquiry> {
    return this.db.transaction().execute(async (tx) => {
      // Serialize the grant check, daily cap and insert across concurrent turns.
      await sql`select pg_advisory_xact_lock(hashtext(${input.sourceProjectId}), 9614)`.execute(tx);
      const existing = (
        await sql<Row>`select * from project_inquiries where id=${input.id}`.execute(tx)
      ).rows[0];
      if (existing) {
        if (
          existing.source_session_id !== input.sourceSessionId ||
          existing.target_project_id !== input.targetProjectId ||
          existing.title !== input.title ||
          existing.body !== input.body ||
          existing.kind !== input.kind
        )
          throw new Error('Inquiry id already identifies a different request');
        return record(existing);
      }
      const grant = await sql`select 1 from project_inquiry_grants
        where source_project_id=${input.sourceProjectId} and target_project_id=${input.targetProjectId}
        and enabled for update`.execute(tx);
      if (!grant.rows.length) throw new Error('Target project is not permitted');
      const usage = (
        await sql<{ n: string }>`select count(*) n from project_inquiries
        where source_project_id=${input.sourceProjectId} and created_at >= date_trunc('day',now())`.execute(
          tx,
        )
      ).rows[0];
      if (Number(usage?.n) >= 20) throw new Error('Daily project inquiry limit reached (20)');
      const result = await sql<Row>`insert into project_inquiries
        (id,source_session_id,target_session_id,source_project_id,target_project_id,title,body,kind,status,user_id)
        values(${input.id},${input.sourceSessionId},${input.targetSessionId},${input.sourceProjectId},
          ${input.targetProjectId},${input.title},${input.body},${input.kind},${input.status},${input.userId}) returning *`.execute(
        tx,
      );
      return record(result.rows[0]!);
    });
  }

  async decide(
    id: string,
    targetSessionId: string,
    approve: boolean,
    userId: string | null,
  ): Promise<boolean> {
    const result =
      await sql`update project_inquiries set status=${approve ? 'approved' : 'rejected'},
      decided_by=${userId} where id=${id} and target_session_id=${targetSessionId}
      and kind='change' and status='pending'
      and exists(select 1 from project_inquiry_grants g where g.source_project_id=project_inquiries.source_project_id
        and g.target_project_id=project_inquiries.target_project_id and g.enabled)`.execute(
        this.db,
      );
    return (result.numAffectedRows ?? 0n) > 0n;
  }

  async block(id: string): Promise<void> {
    await sql`update project_inquiries set status='blocked' where id=${id} and status in ('pending','approved')`.execute(
      this.db,
    );
  }

  async markQueued(id: string): Promise<void> {
    await sql`update project_inquiries set status='queued' where id=${id} and status='approved'`.execute(
      this.db,
    );
  }

  async answer(id: string, targetSessionId: string, answer: string): Promise<boolean> {
    const result = await sql`update project_inquiries set status='answered',answer=${answer}
      where id=${id} and target_session_id=${targetSessionId} and status='queued'`.execute(this.db);
    return (result.numAffectedRows ?? 0n) > 0n;
  }

  async unansweredDeliveries(afterId?: string): Promise<ProjectInquiry[]> {
    return (
      await sql<Row>`select * from project_inquiries where status='answered' and not answer_delivered and id > ${afterId ?? ''} order by id limit 100`.execute(
        this.db,
      )
    ).rows.map(record);
  }
  async markAnswerDelivered(id: string): Promise<void> {
    await sql`update project_inquiries set answer_delivered=true where id=${id} and status='answered'`.execute(
      this.db,
    );
  }

  async undelivered(afterId?: string): Promise<ProjectInquiry[]> {
    return (
      await sql<Row>`select * from project_inquiries where status='approved' and id > ${afterId ?? ''} order by id limit 100`.execute(
        this.db,
      )
    ).rows.map(record);
  }
}
