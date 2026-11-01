import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';

export type RepairMode = 'off' | 'monitor' | 'automatic';
export interface RepairMandate {
  observation_error?: string | null;
  project_id: string;
  sponsor_user_id: string;
  mode: RepairMode;
  revision: number;
  cursor: string | null;
  health: string;
  checked_at: string | null;
}
export interface RepairIncident {
  originating_session_id?: string | null;
  repair_pr: number | null;
  id: string;
  project_id: string;
  resource: string;
  revision: string;
  evidence: string;
  state:
    'open' | 'working' | 'verifying' | 'awaiting_merge' | 'resolved' | 'superseded' | 'blocked';
  owner_session_id: string | null;
  last_session_id: string | null;
  attempts: number;
  dispatch_id: string | null;
  updated_at: string;
}

export interface ManualRepairProposal {
  consent_key: string | null;
  requires_card: boolean;
  id: string;
  project_id: string;
  source_session_id: string;
  user_id: string;
  target_session_id: string;
  number: number;
  branch: string;
  revision: string;
  qa_revision: number;
  mandate_revision: number;
  dispatch_id: string | null;
  reason: string | null;
}

export interface QAState {
  enabled: boolean;
  revision: number;
  sponsor: string | null;
  session_id: string | null;
  health: string;
  active_dispatch: string | null;
  active_seq: number | null;
  active_revision: number | null;
  active_snapshot: string | null;
  wake_day: string | null;
  wakes: number;
}

/** Claims are installation-wide; a timeout alone never releases a live executor. */
export class RepairSupervisionStore {
  constructor(private readonly db: Kysely<Database>) {}
  async proposeManualRepair(
    p: Omit<ManualRepairProposal, 'dispatch_id' | 'reason' | 'consent_key'>,
  ): Promise<void> {
    await sql`insert into qa_manual_repairs(id,project_id,source_session_id,user_id,target_session_id,number,branch,revision,qa_revision,mandate_revision,requires_card) values (${p.id},${p.project_id},${p.source_session_id},${p.user_id},${p.target_session_id},${p.number},${p.branch},${p.revision},${p.qa_revision},${p.mandate_revision},${p.requires_card})`.execute(
      this.db,
    );
  }
  async manualRepair(id: string): Promise<ManualRepairProposal | undefined> {
    return (
      await sql<ManualRepairProposal>`select * from qa_manual_repairs where id=${id}`.execute(
        this.db,
      )
    ).rows[0];
  }
  async pendingManualRepairs(): Promise<ManualRepairProposal[]> {
    return (
      await sql<ManualRepairProposal>`select m.* from qa_manual_repairs m join qa_dispatches d on d.id=m.dispatch_id where d.state='reserved' order by d.created_at limit 50`.execute(
        this.db,
      )
    ).rows;
  }
  async cancelManualRepair(id: string, reason: string): Promise<void> {
    const p = await this.manualRepair(id);
    if (p?.dispatch_id && (await this.cancelReservedDispatch(p.dispatch_id)))
      await sql`update qa_manual_repairs set reason=${reason} where id=${id}`.execute(this.db);
  }
  async manualConsentAvailable(id: string, key: string): Promise<boolean> {
    return (
      (
        await sql`select id from qa_manual_repairs where consent_key=${key} and id<>${id}`.execute(
          this.db,
        )
      ).rows.length === 0
    );
  }
  async manualRepairValid(id: string): Promise<boolean> {
    return (
      (
        await sql`select id from qa_manual_repairs where id=${id} and expires_at > now() and reason is null`.execute(
          this.db,
        )
      ).rows.length > 0
    );
  }
  async qa(): Promise<QAState> {
    const row = (await sql<QAState>`select * from qa_coordinator where id = 1`.execute(this.db))
      .rows[0];
    return (
      row ?? {
        enabled: false,
        revision: 0,
        sponsor: null,
        session_id: null,
        health: 'disabled',
        active_dispatch: null,
        active_seq: null,
        active_revision: null,
        active_snapshot: null,
        wake_day: null,
        wakes: 0,
      }
    );
  }
  async seedQAMonitoring(sponsor: string): Promise<void> {
    await sql`insert into repair_mandates(project_id,sponsor_user_id,mode) select id, ${sponsor}, 'monitor' from projects where kind in ('github','forgejo') and state <> 'absent' on conflict(project_id) do nothing`.execute(
      this.db,
    );
  }
  async qaOffer(
    projectId: string,
    incidentId: string,
    revision: number,
    qaRevision: number,
  ): Promise<void> {
    await sql`insert into qa_proposals(id,project_id,incident_id,mandate_revision,qa_revision) values (${randomUUID()},${projectId},${incidentId},${revision},${qaRevision}) on conflict(project_id,mandate_revision,qa_revision) do nothing`.execute(
      this.db,
    );
  }
  async qaProposals(): Promise<
    { id: string; project_id: string; owner: string; repo: string; resource: string }[]
  > {
    return (
      await sql<{
        id: string;
        project_id: string;
        owner: string;
        repo: string;
        resource: string;
      }>`select p.id,p.project_id,r.owner,r.repo,i.resource from qa_proposals p join projects r on r.id=p.project_id join repair_incidents i on i.id=p.incident_id join repair_mandates m on m.project_id=p.project_id join qa_coordinator q on q.id=1 where p.state='pending' and q.enabled=true and q.revision=p.qa_revision and m.mode='monitor' and m.revision=p.mandate_revision and i.state='open' and not exists(select 1 from repair_session_origins o where o.project_id=i.project_id and o.resource=i.resource) and r.kind in ('github','forgejo') order by p.created_at limit 20`.execute(
        this.db,
      )
    ).rows;
  }
  async qaApprove(id: string, projectId: string, userId: string, allow: boolean): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const result =
        await sql`update qa_proposals p set state=${allow ? 'approved' : 'declined'}, decided_by=${userId} where p.id=${id} and p.project_id=${projectId} and p.state='pending' and exists(select 1 from qa_coordinator q where q.enabled=true and q.revision=p.qa_revision) and exists(select 1 from repair_mandates m where m.project_id=p.project_id and m.mode='monitor' and m.revision=p.mandate_revision) and exists(select 1 from repair_incidents i where i.id=p.incident_id and i.state='open' and not exists(select 1 from repair_session_origins o where o.project_id=i.project_id and o.resource=i.resource)) returning mandate_revision`.execute(
          trx,
        );
      if (!result.rows.length) return false;
      if (allow) {
        const changed =
          await sql`update repair_mandates set mode='automatic',sponsor_user_id=${userId},revision=revision+1 where project_id=${projectId} and mode='monitor' and revision=${(result.rows[0] as { mandate_revision: number }).mandate_revision} returning project_id`.execute(
            trx,
          );
        if (!changed.rows.length)
          throw new Error('Project consent changed; review the current settings');
      }
      return true;
    });
  }
  async configureQA(enabled: boolean, sponsor: string): Promise<void> {
    await sql`insert into qa_coordinator(id, enabled, sponsor, revision, health) values (1, ${enabled}, ${sponsor}, 1, ${enabled ? 'pending' : 'disabled'}) on conflict (id) do update set enabled = excluded.enabled, sponsor = excluded.sponsor, revision = qa_coordinator.revision + 1, health = excluded.health`.execute(
      this.db,
    );
  }
  async qaSession(candidate: string): Promise<string> {
    const row = (
      await sql<{
        session_id: string;
      }>`update qa_coordinator set session_id = coalesce(session_id, ${candidate}) where id = 1 returning session_id`.execute(
        this.db,
      )
    ).rows[0];
    if (!row) throw new Error('QA is not configured');
    return row.session_id;
  }
  async qaHealth(health: string): Promise<void> {
    await sql`update qa_coordinator set health = ${health} where id = 1 and enabled = true`.execute(
      this.db,
    );
  }
  async qaObserve(projectId: string, fingerprint: string): Promise<void> {
    await sql`insert into qa_inbox(project_id, fingerprint) values (${projectId}, ${fingerprint}) on conflict (project_id) do update set fingerprint = excluded.fingerprint, updated_at = now() where qa_inbox.fingerprint <> excluded.fingerprint`.execute(
      this.db,
    );
  }
  async qaPending(
    eligibleProjectIds: readonly string[],
  ): Promise<{ project_id: string; fingerprint: string }[]> {
    if (!eligibleProjectIds.length) return [];
    return (
      await sql<{
        project_id: string;
        fingerprint: string;
      }>`select project_id, fingerprint from qa_inbox where project_id in (${sql.join(eligibleProjectIds)}) and acknowledged is distinct from fingerprint order by updated_at limit 50`.execute(
        this.db,
      )
    ).rows;
  }
  async qaClaim(revision: number, snapshot: string, seq: number): Promise<string | undefined> {
    const id = randomUUID();
    return this.db.transaction().execute(async (trx) => {
      const rows = (
        await sql`update qa_coordinator set active_dispatch = ${id}, active_seq = ${seq}, active_revision = revision, active_snapshot = ${snapshot}, health = 'working', wake_day = current_date::text, wakes = case when wake_day = current_date::text then wakes + 1 else 1 end where id = 1 and enabled = true and revision = ${revision} and active_dispatch is null and (wake_day is distinct from current_date::text or wakes < 24) returning session_id`.execute(
          trx,
        )
      ).rows;
      if (!rows.length) return undefined;
      await sql`insert into qa_decisions(dispatch_id, session_id, snapshot) select ${id}, session_id, ${snapshot} from qa_coordinator where id = 1`.execute(
        trx,
      );
      await sql`insert into qa_dispatches(id,session_id,state) select ${id},session_id,'reserved' from qa_coordinator where id=1`.execute(
        trx,
      );
      return id;
    });
  }
  async qaFinish(dispatchId: string, outcome: string, detail?: string): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const result =
        await sql`update qa_decisions set outcome = ${detail ?? outcome} where dispatch_id = ${dispatchId} and outcome is null returning dispatch_id`.execute(
          trx,
        );
      if (!result.rows.length) return false;
      await sql`update qa_coordinator set active_dispatch = null, active_seq = null, active_revision = null, active_snapshot = null, health = case when enabled then ${outcome} else 'disabled' end where id = 1 and active_dispatch = ${dispatchId}`.execute(
        trx,
      );
      return true;
    });
  }
  async qaAcknowledge(projectId: string, fingerprint: string): Promise<void> {
    await sql`update qa_inbox set acknowledged = ${fingerprint} where project_id = ${projectId} and fingerprint = ${fingerprint}`.execute(
      this.db,
    );
  }
  async mandates(): Promise<RepairMandate[]> {
    return (
      await sql<RepairMandate>`select * from repair_mandates order by project_id`.execute(this.db)
    ).rows;
  }
  async mandate(projectId: string): Promise<RepairMandate | undefined> {
    return (
      await sql<RepairMandate>`select * from repair_mandates where project_id = ${projectId}`.execute(
        this.db,
      )
    ).rows[0];
  }
  async configure(projectId: string, sponsor: string, mode: RepairMode): Promise<void> {
    await sql`insert into repair_mandates (project_id, sponsor_user_id, mode) values (${projectId}, ${sponsor}, ${mode}) on conflict (project_id) do update set mode = excluded.mode, sponsor_user_id = excluded.sponsor_user_id, revision = repair_mandates.revision + 1`.execute(
      this.db,
    );
  }
  async health(
    projectId: string,
    health: string,
    cursor: string | null,
    diagnostic: unknown = null,
  ): Promise<void> {
    await sql`update repair_mandates set observation_error = ${diagnostic === null ? null : JSON.stringify(diagnostic)}, health = ${health}, cursor = ${cursor}, checked_at = now() where project_id = ${projectId}`.execute(
      this.db,
    );
  }
  async incidents(projectId: string): Promise<RepairIncident[]> {
    return (
      await sql<RepairIncident>`select *, (select o.session_id from repair_session_origins o where o.project_id=repair_incidents.project_id and o.resource=repair_incidents.resource) as originating_session_id from repair_incidents where project_id = ${projectId} and (state not in ('resolved','superseded') or owner_session_id is not null or id in (select id from repair_incidents where project_id = ${projectId} order by updated_at desc limit 200)) order by updated_at desc`.execute(
        this.db,
      )
    ).rows;
  }
  async acceptWorkflow(projectId: string, workflow: string, runId: string): Promise<boolean> {
    if (!/^\d+$/.test(runId)) return false;
    const result =
      await sql`insert into repair_workflow_heads (project_id, workflow, run_id) values (${projectId}, ${workflow}, ${runId}::bigint) on conflict (project_id, workflow) do update set run_id = excluded.run_id where excluded.run_id >= repair_workflow_heads.run_id returning run_id`.execute(
        this.db,
      );
    return result.rows.length > 0;
  }
  async invalidateObservation(projectId: string, resource: string): Promise<void> {
    await sql`update repair_incidents set evidence = jsonb_set(evidence::jsonb, '{observedAt}', 'null'::jsonb, true)::text where project_id=${projectId} and resource=${resource} and state not in ('resolved','superseded')`.execute(
      this.db,
    );
  }
  async observe(
    projectId: string,
    resource: string,
    revision: string,
    evidence: string,
  ): Promise<RepairIncident> {
    const result =
      await sql<RepairIncident>`insert into repair_incidents (id, project_id, resource, revision, evidence) values (${randomUUID()}, ${projectId}, ${resource}, ${revision}, ${evidence}) on conflict (project_id, resource, revision) do update set evidence = excluded.evidence, state = case when repair_incidents.state in ('resolved', 'superseded') then 'open' else repair_incidents.state end returning *`.execute(
        this.db,
      );
    return result.rows[0]!;
  }
  async dispatchReceipt(id: string): Promise<
    | {
        session_id: string;
        state: 'reserved' | 'admitted' | 'cancelled' | 'legacy';
        prompt_seq: string | null;
      }
    | undefined
  > {
    return (
      await sql<{
        session_id: string;
        state: 'reserved' | 'admitted' | 'cancelled' | 'legacy';
        prompt_seq: string | null;
      }>`select session_id,state,prompt_seq from qa_dispatches where id=${id}`.execute(this.db)
    ).rows[0];
  }
  async reservedDispatches(): Promise<{ id: string; session_id: string }[]> {
    return (
      await sql<{
        id: string;
        session_id: string;
      }>`select id,session_id from qa_dispatches d where state='reserved' and not exists(select 1 from qa_manual_repairs m where m.dispatch_id=d.id)`.execute(
        this.db,
      )
    ).rows;
  }
  async cancelReservedDispatch(id: string): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(712843, 1)`.execute(trx);
      const cancelled =
        await sql`update qa_dispatches set state='cancelled' where id=${id} and state='reserved' returning id`.execute(
          trx,
        );
      if (!cancelled.rows.length) return false;
      const incidents = (
        await sql<{
          project_id: string;
          resource: string;
        }>`update repair_incidents set owner_session_id=null,state='open',updated_at=now() where dispatch_id=${id} and owner_session_id is not null returning project_id,resource`.execute(
          trx,
        )
      ).rows;
      for (const incident of incidents)
        await sql`update repair_resource_budgets set used=greatest(0,used-1) where project_id=${incident.project_id} and resource=${incident.resource}`.execute(
          trx,
        );
      await sql`delete from session_automation_marker m using repair_attempts a where a.dispatch_id=${id} and m.session_id=a.session_id and m.marker=a.automation_marker`.execute(
        trx,
      );
      await sql`update repair_attempts set ended_at=now(),outcome='not-dispatched' where dispatch_id=${id} and ended_at is null`.execute(
        trx,
      );
      await sql`update qa_decisions set outcome='not-dispatched' where dispatch_id=${id} and outcome is null`.execute(
        trx,
      );
      await sql`update qa_coordinator set active_dispatch=null,active_seq=null,active_revision=null,active_snapshot=null,health=case when enabled then 'dispatch-deferred' else 'disabled' end where active_dispatch=${id}`.execute(
        trx,
      );
      return true;
    });
  }
  async budgetUsed(projectId: string, resource: string): Promise<number> {
    return (
      (
        await sql<{
          used: number;
        }>`select used from repair_resource_budgets where project_id=${projectId} and resource=${resource}`.execute(
          this.db,
        )
      ).rows[0]?.used ?? 0
    );
  }
  async trackRepairPr(id: string, number: number): Promise<void> {
    await sql`update repair_incidents set repair_pr=${number} where id=${id}`.execute(this.db);
  }
  async setAttemptBoundary(dispatchId: string, seq: number): Promise<void> {
    await sql`update repair_attempts set start_seq=${seq} where dispatch_id=${dispatchId} and start_seq is null`.execute(
      this.db,
    );
  }
  async sessionAutomationMarker(dispatchId: string): Promise<string | undefined> {
    return (
      (
        await sql<{
          automation_marker: string | null;
        }>`select automation_marker from repair_attempts where dispatch_id=${dispatchId}`.execute(
          this.db,
        )
      ).rows[0]?.automation_marker ?? undefined
    );
  }
  async attemptBoundary(dispatchId: string): Promise<number | undefined> {
    const row = (
      await sql<{
        start_seq: string | null;
      }>`select start_seq from repair_attempts where dispatch_id=${dispatchId}`.execute(this.db)
    ).rows[0];
    return row?.start_seq == null ? undefined : Number(row.start_seq);
  }
  /** Origin is durable responsibility, not an active repair claim or QA history. */
  async registerSessionOrigin(
    projectId: string,
    resource: string,
    sessionId: string,
  ): Promise<string> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(712843, 1)`.execute(trx);
      await sql`insert into repair_session_origins(project_id,resource,session_id) values (${projectId},${resource},${sessionId}) on conflict do nothing`.execute(
        trx,
      );
      return (
        await sql<{
          session_id: string;
        }>`select session_id from repair_session_origins where project_id=${projectId} and resource=${resource}`.execute(
          trx,
        )
      ).rows[0]!.session_id;
    });
  }
  async sessionOrigin(projectId: string, resource: string): Promise<string | undefined> {
    return (
      await sql<{
        session_id: string;
      }>`select session_id from repair_session_origins where project_id=${projectId} and resource=${resource}`.execute(
        this.db,
      )
    ).rows[0]?.session_id;
  }
  async associate(projectId: string, resource: string, sessionId: string): Promise<void> {
    await sql`insert into repair_session_history (project_id, resource, session_id) values (${projectId}, ${resource}, ${sessionId}) on conflict do nothing`.execute(
      this.db,
    );
  }
  async history(projectId: string, resource: string): Promise<string[]> {
    return (
      await sql<{
        session_id: string;
      }>`select session_id from repair_session_history where project_id = ${projectId} and resource = ${resource} order by created_at desc`.execute(
        this.db,
      )
    ).rows.map((row) => row.session_id);
  }
  async claimSessionRepair(
    id: string,
    sessionId: string,
    marker: string,
  ): Promise<RepairIncident | undefined> {
    return this.claim(id, sessionId, 0, undefined, undefined, undefined, true, marker);
  }
  async claim(
    id: string,
    sessionId: string,
    mandateRevision: number,
    qaRevision?: number,
    manualProposalId?: string,
    consentKey?: string,
    sessionOrigin = false,
    automationMarker?: string,
  ): Promise<RepairIncident | undefined> {
    return this.db.transaction().execute(async (trx) => {
      // The lock covers the global limit as well as a project's exclusive owner.
      await sql`select pg_advisory_xact_lock(712843, 1)`.execute(trx);
      if (sessionOrigin && !automationMarker)
        throw new Error('A session repair requires a durable automation marker');
      if (
        sessionOrigin &&
        (
          await sql`select 1 from session_automation_marker where session_id=${sessionId} and marker=${automationMarker}`.execute(
            trx,
          )
        ).rows.length
      )
        return undefined;
      let manual: ManualRepairProposal | undefined;
      if (manualProposalId) {
        manual = (
          await sql<ManualRepairProposal>`select * from qa_manual_repairs where id=${manualProposalId} and target_session_id=${sessionId} and dispatch_id is null and reason is null and expires_at > now() and qa_revision=${qaRevision ?? -1} and mandate_revision=${mandateRevision} for update`.execute(
            trx,
          )
        ).rows[0];
        if (!manual) return undefined;
        if (
          consentKey &&
          (
            await sql`select id from qa_manual_repairs where consent_key=${consentKey} and id<>${manual.id}`.execute(
              trx,
            )
          ).rows.length
        )
          return undefined;
        const incident = (
          await sql<RepairIncident>`select * from repair_incidents where id=${id}`.execute(trx)
        ).rows[0];
        if (
          !incident ||
          incident.project_id !== manual.project_id ||
          incident.resource !== `pr:${manual.number}` ||
          incident.revision !== manual.revision
        )
          return undefined;
      }
      const notSessionOrigin = !sessionOrigin;
      const result =
        await sql<RepairIncident>`update repair_incidents i set state = 'working', owner_session_id = ${sessionId}, last_session_id = ${sessionId}, attempts = attempts + 1, dispatch_id = ${randomUUID()}, updated_at = now() where i.id = ${id} and ((${sessionOrigin} and exists(select 1 from repair_session_origins o where o.project_id=i.project_id and o.resource=i.resource and o.session_id=${sessionId})) or (${notSessionOrigin} and not exists(select 1 from repair_session_origins o where o.project_id=i.project_id and o.resource=i.resource))) and (${qaRevision === undefined} or exists (select 1 from qa_coordinator c where c.id = 1 and c.enabled = true and c.revision = ${qaRevision ?? -1})) and (i.state = 'open' or ((${sessionOrigin} or ${manual !== undefined}) and i.state = 'verifying' and i.owner_session_id is null)) and coalesce((select used from repair_resource_budgets b where b.project_id=i.project_id and b.resource=i.resource),0) < 2 and (${sessionOrigin} or exists (select 1 from repair_mandates m where m.project_id = i.project_id and (m.mode = 'automatic' or (${manual !== undefined} and m.mode = 'monitor')) and m.revision = ${mandateRevision})) and not exists (select 1 from repair_incidents other where other.project_id = i.project_id and other.owner_session_id is not null) and (select count(*) from repair_incidents where owner_session_id is not null) < 2 returning i.*`.execute(
          trx,
        );
      const claim = result.rows[0];
      if (!claim && sessionOrigin)
        await sql`update repair_incidents i set state='blocked',updated_at=now() where i.id=${id} and i.state='open' and i.owner_session_id is null and coalesce((select used from repair_resource_budgets b where b.project_id=i.project_id and b.resource=i.resource),0)>=2`.execute(
          trx,
        );
      if (claim?.dispatch_id) {
        if (manual)
          await sql`update qa_manual_repairs set dispatch_id=${claim.dispatch_id},consent_key=${consentKey ?? null} where id=${manual.id}`.execute(
            trx,
          );
        if (sessionOrigin)
          await sql`insert into session_automation_marker(session_id,marker) values (${sessionId},${automationMarker})`.execute(
            trx,
          );
        await sql`insert into repair_attempts (dispatch_id, incident_id, session_id, automation_marker) values (${claim.dispatch_id}, ${claim.id}, ${sessionId}, ${automationMarker ?? null})`.execute(
          trx,
        );
        await sql`insert into qa_dispatches(id,session_id,state) values (${claim.dispatch_id},${sessionId},'reserved')`.execute(
          trx,
        );
        await sql`insert into repair_resource_budgets(project_id,resource,used) values (${claim.project_id},${claim.resource},1) on conflict(project_id,resource) do update set used=repair_resource_budgets.used+1`.execute(
          trx,
        );
      }
      return claim;
    });
  }
  async finishAttempt(
    id: string,
    dispatchId: string,
    state: 'verifying' | 'awaiting_merge' | 'blocked',
    evidence: string,
  ): Promise<void> {
    await sql`update repair_incidents set state = ${state}, owner_session_id = null, evidence = ${evidence}, updated_at = now() where id = ${id} and dispatch_id = ${dispatchId}`.execute(
      this.db,
    );
    await sql`update repair_attempts set ended_at = now(), outcome = ${state} where dispatch_id = ${dispatchId} and incident_id = ${id} and ended_at is null`.execute(
      this.db,
    );
  }
  async retireResource(projectId: string, resource: string): Promise<void> {
    await sql`update repair_incidents set state = 'superseded', updated_at = now() where project_id = ${projectId} and resource = ${resource} and state not in ('resolved', 'superseded') and owner_session_id is null`.execute(
      this.db,
    );
  }
  async blockUnowned(id: string): Promise<void> {
    await sql`update repair_incidents set state = 'blocked' where id = ${id} and owner_session_id is null and state = 'open'`.execute(
      this.db,
    );
  }
  async flagStalled(id: string): Promise<void> {
    await sql`update repair_incidents set state = 'blocked' where id = ${id} and state = 'working' and owner_session_id is not null and updated_at < now() - interval '30 minutes'`.execute(
      this.db,
    );
  }
  async supersede(projectId: string, resource: string, revision: string): Promise<void> {
    await sql`update repair_incidents set state = 'superseded', updated_at = now() where project_id = ${projectId} and resource = ${resource} and revision <> ${revision} and owner_session_id is null and state not in ('resolved', 'superseded')`.execute(
      this.db,
    );
  }
  async bindSession(id: string, sessionId: string): Promise<void> {
    await sql`insert into repair_session_history (project_id, resource, session_id) select project_id, resource, ${sessionId} from repair_incidents where id = ${id} on conflict do nothing`.execute(
      this.db,
    );
  }
  async resolve(id: string, revision: string): Promise<void> {
    // Each resource/revision contributes at most one verified budget reset,
    // even if an older green revision is rediscovered after newer successes.
    await this.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(712843, 1)`.execute(trx);
      const row = (
        await sql<{
          project_id: string;
          resource: string;
        }>`update repair_incidents set state='resolved',verified_success=true,updated_at=now() where id=${id} and revision=${revision} and owner_session_id is null and verified_success=false returning project_id,resource`.execute(
          trx,
        )
      ).rows[0];
      if (row)
        await sql`update repair_resource_budgets set used=0,cycle=cycle+1 where project_id=${row.project_id} and resource=${row.resource}`.execute(
          trx,
        );
      else
        await sql`update repair_incidents set state='resolved',updated_at=now() where id=${id} and revision=${revision} and owner_session_id is null`.execute(
          trx,
        );
    });
  }
  async retry(id: string, includeAbandonedPr = false): Promise<boolean> {
    const rows =
      await sql`update repair_incidents i set state='open',repair_pr=null,updated_at=now() where id=${id} and (state in ('verifying','blocked') or (${includeAbandonedPr} and state='awaiting_merge')) and owner_session_id is null and coalesce((select used from repair_resource_budgets b where b.project_id=i.project_id and b.resource=i.resource),0)<2 and exists(select 1 from repair_mandates m where m.project_id=i.project_id and m.mode='automatic') returning id`.execute(
        this.db,
      );
    return rows.rows.length > 0;
  }
}
