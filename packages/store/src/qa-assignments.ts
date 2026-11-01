import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';

export type QAAssignmentState =
  | 'proposed'
  | 'queued'
  | 'running'
  | 'waiting'
  | 'verifying'
  | 'completed'
  | 'blocked'
  | 'stopping'
  | 'stopped';
export interface QAAssignment {
  id: string;
  project_id: string;
  source_session_id: string;
  user_id: string;
  target_session_id: string | null;
  state: QAAssignmentState;
  title: string;
  instruction: string;
  criteria: string;
  qa_revision: number;
  mandate_revision: number;
  consent_key: string | null;
  attempt: number;
  dispatch_id: string | null;
  feedback: string;
  evidence: string;
  reason: string | null;
  version: number;
}
const active = ['queued', 'running', 'waiting', 'verifying', 'stopping'];
export class QAAssignmentStore {
  constructor(private readonly db: Kysely<Database>) {}
  async get(id: string): Promise<QAAssignment | undefined> {
    return (await sql<QAAssignment>`select * from qa_assignments where id=${id}`.execute(this.db))
      .rows[0];
  }
  async list(source?: string): Promise<QAAssignment[]> {
    return (
      await sql<QAAssignment>`select * from qa_assignments where ((${source ?? null}::text is null and state in ('queued','running','waiting','verifying','stopping')) or source_session_id=${source ?? null}) order by case when state in ('queued','running','waiting','verifying','stopping') then 0 else 1 end, created_at desc limit 200`.execute(
        this.db,
      )
    ).rows;
  }
  async propose(
    p: Pick<
      QAAssignment,
      | 'id'
      | 'project_id'
      | 'source_session_id'
      | 'user_id'
      | 'target_session_id'
      | 'title'
      | 'instruction'
      | 'criteria'
      | 'qa_revision'
      | 'mandate_revision'
    >,
  ): Promise<void> {
    await sql`insert into qa_assignments(id,project_id,source_session_id,user_id,target_session_id,title,instruction,criteria,qa_revision,mandate_revision,state) values (${p.id},${p.project_id},${p.source_session_id},${p.user_id},${p.target_session_id},${p.title},${p.instruction},${p.criteria},${p.qa_revision},${p.mandate_revision},'proposed') on conflict(id) do nothing`.execute(
      this.db,
    );
  }
  async approve(id: string, version: number, consent: string): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(712843,1)`.execute(tx);
      const row = (
        await sql<QAAssignment>`select * from qa_assignments where id=${id} and version=${version} and state='proposed' and expires_at>now() for update`.execute(
          tx,
        )
      ).rows[0];
      if (!row) return false;
      const conflicts =
        await sql`select 1 from qa_assignments where consent_key=${consent} or (state in (${sql.join(active)}) and project_id=${row.project_id}) union all select 1 from repair_incidents where project_id=${row.project_id} and owner_session_id is not null union all select 1 from qa_manual_repairs where consent_key=${consent}`.execute(
          tx,
        );
      if (conflicts.rows.length) return false;
      const count = (
        await sql<{
          n: string;
        }>`select ((select count(*) from repair_incidents where owner_session_id is not null)+(select count(*) from qa_assignments where state in (${sql.join(active)}))) as n`.execute(
          tx,
        )
      ).rows[0];
      if (Number(count?.n) >= 2) return false;
      const authorized =
        await sql`select 1 from qa_coordinator q, repair_mandates m where q.id=1 and q.enabled and q.revision=${row.qa_revision} and m.project_id=${row.project_id} and m.mode<>'off' and m.revision=${row.mandate_revision}`.execute(
          tx,
        );
      if (!authorized.rows.length) return false;
      await sql`update qa_assignments set state='queued',consent_key=${consent},version=version+1 where id=${id}`.execute(
        tx,
      );
      return true;
    });
  }
  async bind(id: string, sessionId: string): Promise<void> {
    await sql`update qa_assignments set target_session_id=${sessionId} where id=${id} and state='queued' and target_session_id is null`.execute(
      this.db,
    );
  }
  async reserve(id: string): Promise<QAAssignment | undefined> {
    return this.db.transaction().execute(async (tx) => {
      const a = (
        await sql<QAAssignment>`select * from qa_assignments where id=${id} for update`.execute(tx)
      ).rows[0];
      if (!a || a.state !== 'queued' || !a.target_session_id) return undefined;
      if (!a.dispatch_id) {
        const dispatch = `qa-assignment:${id}:attempt:${a.attempt}`;
        await sql`insert into qa_dispatches(id,session_id,state) values (${dispatch},${a.target_session_id},'reserved') on conflict do nothing`.execute(
          tx,
        );
        await sql`update qa_assignments set dispatch_id=${dispatch} where id=${id}`.execute(tx);
        a.dispatch_id = dispatch;
      }
      return a;
    });
  }
  async change(
    id: string,
    version: number,
    state: QAAssignmentState,
    reason: string | null,
    evidence = '',
    feedback = '',
  ): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      const a = (
        await sql<QAAssignment>`select * from qa_assignments where id=${id} and version=${version} for update`.execute(
          tx,
        )
      ).rows[0];
      if (!a) return false;
      if (state === 'queued' && (a.state !== 'verifying' || a.attempt >= 2)) return false;
      // A stop cancels reservation in the same transaction as the assignment fence.
      if (['stopping', 'blocked', 'stopped'].includes(state) && a.dispatch_id)
        await sql`update qa_dispatches set state='cancelled' where id=${a.dispatch_id} and state='reserved'`.execute(
          tx,
        );
      const next = (
        await sql<QAAssignment>`update qa_assignments set state=${state},reason=${reason},evidence=${evidence},feedback=${feedback},version=version+1,attempt=attempt+${state === 'queued' ? 1 : 0},dispatch_id=${state === 'queued' ? null : a.dispatch_id} where id=${id} returning *`.execute(
          tx,
        )
      ).rows[0]!;
      const notification = `qa-assignment:${id}:notification:${next.version}`;
      await sql`insert into qa_dispatches(id,session_id,state) values (${notification},${a.source_session_id},'reserved')`.execute(
        tx,
      );
      await sql`insert into qa_assignment_notifications(id,assignment_id,dispatch_id,payload) values (${notification},${id},${notification},${JSON.stringify(next)})`.execute(
        tx,
      );
      return true;
    });
  }
  async acknowledgeNotification(id: string, dispatchId: string): Promise<void> {
    await sql`update qa_assignment_notifications set acknowledged=true where id=${id} and dispatch_id=${dispatchId}`.execute(
      this.db,
    );
  }
  async retryNotification(id: string, dispatchId: string): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      const n = await tx
        .selectFrom('qa_assignment_notifications')
        .selectAll()
        .where('id', '=', id)
        .where('dispatch_id', '=', dispatchId)
        .where('acknowledged', '=', false)
        .forUpdate()
        .executeTakeFirst();
      if (!n) return true;
      if (n.attempt >= 2) {
        await tx
          .updateTable('qa_assignment_notifications')
          .set({ acknowledged: true })
          .where('id', '=', id)
          .execute();
        return false;
      }
      const receipt = await tx
        .selectFrom('qa_dispatches')
        .selectAll()
        .where('id', '=', dispatchId)
        .executeTakeFirst();
      if (!receipt || receipt.state !== 'admitted') return true;
      const next = `${id}:retry:${n.attempt + 1}`;
      await sql`insert into qa_dispatches(id,session_id,state) values (${next},${receipt.session_id},'reserved')`.execute(
        tx,
      );
      await tx
        .updateTable('qa_assignment_notifications')
        .set({ attempt: n.attempt + 1, dispatch_id: next })
        .where('id', '=', id)
        .execute();
      return true;
    });
  }
  async notifications(): Promise<
    { id: string; assignment_id: string; dispatch_id: string; payload: string }[]
  > {
    return (
      await sql<{
        id: string;
        assignment_id: string;
        dispatch_id: string;
        payload: string;
      }>`select n.* from qa_assignment_notifications n join qa_dispatches d on d.id=n.dispatch_id where n.acknowledged=false and d.state in ('reserved','admitted') order by d.created_at limit 50`.execute(
        this.db,
      )
    ).rows;
  }
}
