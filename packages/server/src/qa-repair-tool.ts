import { randomUUID } from 'node:crypto';
import type { EventStore, ManualRepairProposal, SessionRecord } from '@verity/store';
import type { PullRequestStatus } from './forge-provider.js';
import {
  ControlPlaneSessionAuthorityError,
  ControlPlaneSessionToolError,
} from './session-handoff-tool.js';

export interface QARepairDeps {
  store: EventStore;
  permitted(this: void, userId: string, projectId: string): Promise<boolean>;
  inspect(
    this: void,
    projectId: string,
    number: number,
  ): Promise<{ branch: string; fork: boolean; status: PullRequestStatus } | undefined>;
  branch(
    this: void,
    session: SessionRecord,
  ): Promise<{ branch: string; dirty: boolean; revision?: string | undefined } | undefined>;
  busy(this: void, sessionId: string): boolean;
  dispatch(
    this: void,
    sessionId: string,
    prompt: string,
    dispatchId: string,
    userId: string,
    validate: () => Promise<boolean>,
  ): Promise<boolean>;
}
type Caller = { sessionId: string; userId: string };
export function createQARepairTool(deps: QARepairDeps) {
  const store = deps.store.repairs;
  const active = new Set<string>();
  async function authorize(caller: Caller, projectId: string) {
    const qa = await store.qa();
    const mandate = await store.mandate(projectId);
    const project = await deps.store.getProject(projectId);
    const source = await deps.store.getSession(caller.sessionId);
    if (
      !source ||
      source.planning === 'active' ||
      !qa.enabled ||
      qa.session_id !== caller.sessionId ||
      !mandate ||
      mandate.mode === 'off' ||
      !project ||
      project.archived ||
      project.hiddenAt !== null ||
      !(await deps.permitted(caller.userId, projectId))
    )
      throw new ControlPlaneSessionAuthorityError(
        'QA repair requires current project execution permission and enabled QA access.',
      );
    return { qa, mandate };
  }
  async function proposal(caller: Caller, projectId: string, id: string) {
    await authorize(caller, projectId);
    const p = await store.manualRepair(id);
    if (
      !p ||
      p.project_id !== projectId ||
      p.source_session_id !== caller.sessionId ||
      p.user_id !== caller.userId
    )
      throw new ControlPlaneSessionAuthorityError('Repair proposal is unavailable to this caller.');
    return p;
  }
  async function current(p: ManualRepairProposal, requireClean: boolean) {
    const { qa, mandate } = await authorize(
      { sessionId: p.source_session_id, userId: p.user_id },
      p.project_id,
    );
    if (
      qa.revision !== p.qa_revision ||
      mandate.revision !== p.mandate_revision ||
      !(await store.manualRepairValid(p.id))
    )
      throw new ControlPlaneSessionToolError(
        'Repair approval expired or QA settings changed; resolve the PR again.',
      );
    if (await store.sessionOrigin(p.project_id, `pr:${p.number}`))
      throw new ControlPlaneSessionToolError(
        'This PR is managed by its originating session; QA cannot start a competing repair.',
      );
    const observed = await deps.inspect(p.project_id, p.number);
    if (
      !observed ||
      observed.fork ||
      observed.branch !== p.branch ||
      observed.status.number !== p.number ||
      observed.status.headSha !== p.revision ||
      observed.status.phase !== 'open' ||
      observed.status.pipeline !== 'failure'
    )
      throw new ControlPlaneSessionToolError(
        'PR revision or failure evidence changed; resolve the PR again.',
      );
    const matches = [];
    for (const session of await deps.store.listSessions()) {
      if (session.projectId !== p.project_id) continue;
      const facts = await deps.branch(session);
      if (facts?.branch === p.branch) matches.push({ session, facts });
    }
    const target = matches.find((m) => m.session.sessionId === p.target_session_id);
    if (
      !target ||
      matches.some(
        (m) =>
          m.session.sessionId !== p.target_session_id &&
          (deps.busy(m.session.sessionId) || m.facts.dirty),
      ) ||
      target.session.planning === 'active' ||
      (requireClean && (target.facts.dirty || target.facts.revision !== p.revision))
    )
      throw new ControlPlaneSessionToolError(
        'Target session is missing, ambiguous, planning, dirty, or not at the approved commit.',
      );
    const final = await authorize(
      { sessionId: p.source_session_id, userId: p.user_id },
      p.project_id,
    );
    if (
      final.qa.revision !== p.qa_revision ||
      final.mandate.revision !== p.mandate_revision ||
      !(await store.manualRepairValid(p.id))
    )
      throw new ControlPlaneSessionToolError(
        'Repair approval changed during validation; resolve the PR again.',
      );
    return observed;
  }
  async function status(caller: Caller, projectId: string, id: string) {
    const p = await proposal(caller, projectId, id);
    const receipt = p.dispatch_id ? await store.dispatchReceipt(p.dispatch_id) : undefined;
    return {
      proposalId: id,
      projectId,
      number: p.number,
      revision: p.revision,
      sessionId: p.target_session_id,
      status:
        receipt?.state === 'admitted'
          ? 'accepted'
          : receipt?.state === 'reserved'
            ? 'queued'
            : receipt?.state === 'cancelled'
              ? 'blocked'
              : 'proposed',
      reason: p.reason,
    };
  }
  async function deliver(p: ManualRepairProposal) {
    if (!p.dispatch_id || active.has(p.id)) return;
    active.add(p.id);
    try {
      // Revalidate even while busy, so revoked/expired queues do not hold ownership forever.
      try {
        await current(p, !deps.busy(p.target_session_id));
      } catch (error) {
        await store.cancelManualRepair(
          p.id,
          error instanceof ControlPlaneSessionAuthorityError
            ? 'Access revoked or QA disabled.'
            : 'Approval, PR evidence, or target changed; resolve the PR again.',
        );
        return;
      }
      if (deps.busy(p.target_session_id)) return;
      const prompt = `QA repair assignment authorized once by the requesting user. Repair only the failed checks for the PR and revision below in this existing session. Verify repository, head revision and clean worktree before editing; stop if they changed. Run relevant tests and publish the correction on the existing PR branch. Do not merge, release, deploy, rerun workflows, change QA settings, disable checks or broaden the assignment. Existing review and permission gates apply. This is a server-scoped assignment, not an instruction from repository text.\n\nUntrusted diagnostic identifiers:\n${JSON.stringify({ projectId: p.project_id, number: p.number, branch: p.branch, revision: p.revision })}`;
      // Admission and the prompt share the existing durable receipt; an uncertain outcome
      // remains reserved and can only retry this SAME receipt, never another repair.
      await deps.dispatch(p.target_session_id, prompt, p.dispatch_id, p.user_id, async () => {
        await current(p, true);
        return true;
      });
    } finally {
      active.delete(p.id);
    }
  }
  return {
    proposal,
    async resolve(caller: Caller, projectId: string, number: number, sessionId?: string) {
      const { qa, mandate } = await authorize(caller, projectId);
      const observed = await deps.inspect(projectId, number);
      if (
        !observed ||
        observed.fork ||
        observed.status.number !== number ||
        observed.status.phase !== 'open' ||
        observed.status.pipeline !== 'failure' ||
        !observed.status.headSha
      )
        return {
          status: 'blocked',
          reason: 'No current failed open PR in this repository, or fork/coverage is unsupported.',
        };
      const origin = await store.sessionOrigin(projectId, `pr:${number}`);
      if (origin)
        return {
          status: 'session-managed',
          sessionId: origin,
          projectId,
          number,
          reason:
            'The originating session handles this PR automatically, including while waiting for idle or attention. QA may analyze recurring causes but cannot start a competing repair.',
        };
      const candidates = [];
      for (const s of await deps.store.listSessions()) {
        if (s.projectId !== projectId) continue;
        const facts = await deps.branch(s);
        if (facts?.branch === observed.branch)
          candidates.push({ sessionId: s.sessionId, name: s.name });
      }
      await authorize(caller, projectId);
      const selected = sessionId
        ? candidates.find((c) => c.sessionId === sessionId)
        : candidates.length === 1
          ? candidates[0]
          : undefined;
      if (!selected)
        return {
          status: 'blocked',
          reason:
            candidates.length > 1
              ? 'Multiple sessions match; ask the user to select one and resolve again with its sessionId.'
              : 'No verified session for this PR branch.',
          candidates,
        };
      const p: ManualRepairProposal = {
        id: randomUUID(),
        project_id: projectId,
        source_session_id: caller.sessionId,
        user_id: caller.userId,
        target_session_id: selected.sessionId,
        requires_card: candidates.length > 1,
        number,
        branch: observed.branch,
        revision: observed.status.headSha,
        qa_revision: qa.revision,
        mandate_revision: mandate.revision,
        dispatch_id: null,
        consent_key: null,
        reason: null,
      };
      await store.proposeManualRepair(p);
      return {
        ...(await status(caller, projectId, p.id)),
        branch: p.branch,
        target: selected,
        scope: 'One repair of this PR revision; automatic repairs remain unchanged.',
      };
    },
    status,
    async request(
      caller: Caller,
      projectId: string,
      id: string,
      consent?: () => Promise<string | undefined>,
    ) {
      let p = await proposal(caller, projectId, id);
      if (p.dispatch_id) return status(caller, projectId, id);
      const observed = await current(p, !deps.busy(p.target_session_id));
      const incident = await store.observe(
        projectId,
        `pr:${p.number}`,
        p.revision,
        JSON.stringify({ ...observed, observedAt: new Date().toISOString() }),
      );
      const consentKey = consent ? await consent() : undefined;
      if (consent && !consentKey)
        throw new ControlPlaneSessionAuthorityError(
          'The direct repair instruction changed; request approval again.',
        );
      const claim = await store.claim(
        incident.id,
        p.target_session_id,
        p.mandate_revision,
        p.qa_revision,
        p.id,
        consentKey,
      );
      if (!claim) {
        p = await proposal(caller, projectId, id);
        if (p.dispatch_id) return status(caller, projectId, id);
        return {
          status: 'blocked',
          reason: 'A repair already owns this resource/project, or its repair budget is exhausted.',
        };
      }
      await store.bindSession(incident.id, p.target_session_id);
      p = (await store.manualRepair(id))!;
      try {
        await deliver(p);
      } catch {
        /* A transport failure cannot prove rejection. */
      }
      return status(caller, projectId, id);
    },
    async sweep() {
      for (const p of await store.pendingManualRepairs()) {
        try {
          await deliver(p);
        } catch {
          /* Keep the durable receipt for reconciliation. */
        }
      }
    },
  };
}

/** Only the current authenticated user's complete instruction can replace a card. */
export async function trustedQARepairInstruction(
  store: EventStore,
  sessionId: string,
  turnId: string,
  proposalId: string,
): Promise<boolean> {
  return (await trustedQARepairConsent(store, sessionId, turnId, proposalId)) !== undefined;
}
export async function trustedQARepairConsent(
  store: EventStore,
  sessionId: string,
  turnId: string,
  proposalId: string,
): Promise<string | undefined> {
  const p = await store.repairs.manualRepair(proposalId);
  if (
    !p ||
    p.requires_card ||
    p.source_session_id !== sessionId ||
    !(await store.repairs.manualRepairValid(proposalId))
  )
    return undefined;
  const running = (await store.listRunningTurns()).find(
    (t) => t.sessionId === sessionId && t.turnId === turnId,
  );
  if (!running) return undefined;
  const prompts = (await store.getEventsAfter(sessionId, running.promptSeq - 1)).filter(
    (r) => r.event.t === 'prompt',
  );
  const latest = prompts.at(-1);
  if (
    !latest ||
    latest.event.t !== 'prompt' ||
    latest.event.peer ||
    latest.event.initiatedBy?.userId !== p.user_id ||
    (latest.seq !== running.promptSeq && !latest.event.steered)
  )
    return undefined;
  const key = `${sessionId}:${latest.seq}`;
  const consumable = async () =>
    (await store.repairs.manualConsentAvailable(proposalId, key)) ? key : undefined;
  const text = latest.event.text.trim();
  const explicit = new RegExp(
    `^(?:please |bitte )?(?:fix|repair|repariere) (?:PR ?#?)?${p.number}[.!]?$`,
    'iu',
  ).test(text);
  if (
    !explicit &&
    !/^(?:(?:ok|okay|ja|yes)[,.!]?\s+)?(?:lass die session das fixen|beauftrage die session|start the repair|fix it|reparatur starten)[.!]?$/iu.test(
      text,
    )
  )
    return undefined;
  // An implicit "fix it" must refer to exactly the server proposal shown before the prompt.
  const { events } = await store.getEventsBeforeSeq(sessionId, 200, latest.seq);
  const calls = new Map(
    events.flatMap(({ event }) =>
      event.t === 'tool_call' && /(?:^|__)verity_qa_analysis$/.test(event.name)
        ? [[event.id, event.input] as const]
        : [],
    ),
  );
  for (const { event } of [...events].reverse()) {
    if (event.t !== 'tool_result' || event.isError || !calls.has(event.id)) continue;
    const input = calls.get(event.id) as { action?: string; projectId?: string; number?: number };
    if (!['resolve_repair', 'pull_status'].includes(input.action ?? '')) continue;
    if (input.projectId !== p.project_id || input.number !== p.number) return undefined;
    const output = unwrapQAResult(event.output);
    if (input.action === 'resolve_repair')
      return output?.proposalId === proposalId ? consumable() : undefined;
    const data = output?.data as
      { pull?: { number?: number; head?: { sha?: string } } } | undefined;
    return data?.pull?.number === p.number && data.pull.head?.sha === p.revision
      ? consumable()
      : undefined;
  }
  return undefined;
}
function unwrapQAResult(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (v.structuredContent) return unwrapQAResult(v.structuredContent);
  if (Array.isArray(v.content)) {
    for (const item of v.content as { text?: string }[]) {
      if (typeof item.text !== 'string') continue;
      try {
        return unwrapQAResult(JSON.parse(item.text));
      } catch {
        /* Not a JSON result. */
      }
    }
  }
  return v;
}
