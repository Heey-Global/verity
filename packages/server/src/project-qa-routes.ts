import type { EventStore, ProjectPermission, QAIssue, RepairIncident } from '@verity/store';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

/** A source counts as fresh for this long after QA last read it (sweeps run every 2 min). */
const FRESH_MS = 10 * 60_000;

type Permission = ProjectPermission;

/** One issue as the QA page shows it: state, the newest incident and the work done on it. */
interface PublicQAIssue {
  id: string;
  key: string;
  state: QAIssue['state'];
  reason: QAIssue['reason'];
  detail: string | null;
  revision: string | null;
  /** Failing checks or the workflow, as observed; untrusted forge text. */
  failing: string | null;
  incidents: number;
  roundsUsed: number;
  roundsAllowed: number;
  repairing: boolean;
  sessionId: string | null;
  sessionName: string | null;
  originSessionId: string | null;
  detectedAt: string;
  updatedAt: string;
}

function failing(incident: RepairIncident | undefined): string | null {
  if (!incident) return null;
  try {
    const evidence = JSON.parse(incident.evidence) as {
      status?: { checks?: { failed?: number; total?: number }; failingChecks?: string[] };
      workflow?: string;
      name?: string;
    };
    if (evidence.status?.failingChecks?.length)
      return evidence.status.failingChecks.slice(0, 3).join(', ').slice(0, 200);
    if (evidence.status?.checks?.failed)
      return `${String(evidence.status.checks.failed)} of ${String(evidence.status.checks.total ?? '?')} checks failed`;
    return (evidence.name ?? evidence.workflow ?? null)?.slice(0, 200) ?? null;
  } catch {
    return null;
  }
}

/** The QA role of one coding project as the app shows it. */
async function projectQAState(store: EventStore, projectId: string) {
  const qa = await store.repairs.qa();
  const project = await store.getProject(projectId);
  const coding = !!project && ['github', 'forgejo'].includes(project.kind ?? 'github');
  const mandate = await store.repairs.mandate(projectId);
  const role = await store.repairs.projectQA.role(projectId);
  const incidents = await store.repairs.incidents(projectId);
  const issues: PublicQAIssue[] = [];
  for (const issue of await store.repairs.projectQA.issues(projectId)) {
    const own = incidents.filter((i) => i.issue_id === issue.id);
    const latest = own[0];
    const sessionId =
      own.find((i) => i.owner_session_id)?.owner_session_id ?? latest?.last_session_id ?? null;
    const session = sessionId ? await store.getSession(sessionId) : undefined;
    const used = latest ? await store.repairs.budgetUsed(projectId, latest.resource) : 0;
    issues.push({
      id: issue.id,
      key: issue.key,
      state: issue.state,
      reason: issue.reason,
      detail: issue.detail,
      revision: latest?.revision ?? null,
      failing: failing(latest),
      incidents: own.length,
      roundsUsed: used,
      roundsAllowed: latest ? await store.repairs.projectQA.roundsAllowed(latest.id) : 0,
      repairing: own.some((i) => i.owner_session_id !== null),
      sessionId: session ? sessionId : null,
      sessionName: session?.name ?? null,
      originSessionId: latest?.originating_session_id ?? null,
      detectedAt: new Date(issue.created_at).toISOString(),
      updatedAt: new Date(issue.updated_at).toISOString(),
    });
  }
  const checkedAt = mandate?.checked_at ? new Date(mandate.checked_at).toISOString() : null;
  const fresh = !!checkedAt && Date.now() - Date.parse(checkedAt) < FRESH_MS;
  const unreadable =
    !mandate || ['unavailable', 'access-revoked', 'pending'].includes(mandate.health);
  return {
    enabled: qa.enabled,
    coding,
    mode: mandate?.mode ?? null,
    sessionId: role?.session_id ?? null,
    brakeAt: await store.repairs.projectQA.brake(),
    checkedAt,
    sources: {
      pullRequests: {
        readable: fresh && !unreadable,
        failing: new Set(
          incidents
            .filter(
              (i) => i.resource.startsWith('pr:') && !['resolved', 'superseded'].includes(i.state),
            )
            .map((i) => i.resource),
        ).size,
      },
      ci: {
        readable: fresh && !unreadable && mandate?.health !== 'workflow-monitoring-unsupported',
        failing: new Set(
          incidents
            .filter(
              (i) =>
                i.resource.startsWith('workflow:') && !['resolved', 'superseded'].includes(i.state),
            )
            .map((i) => i.resource),
        ).size,
      },
    },
    issues,
    repairSessions: await store.repairs.projectQA.repairSessions(projectId),
  };
}

export function registerProjectQARoutes(
  app: FastifyInstance,
  store: EventStore,
  changed: (projectId: string) => void,
): void {
  const params = z.object({ id: z.string().min(1) });
  const allowed = async (request: FastifyRequest, projectId: string, permission: Permission) => {
    const userId = request.localUserId;
    return (
      userId != null &&
      ((await store.isActiveAdministrator(userId)) ||
        (await store.hasProjectPermission(userId, projectId, permission)))
    );
  };
  app.get('/projects/:id/qa', async (request, reply) => {
    const { id } = params.parse(request.params);
    if (!(await allowed(request, id, 'read')))
      return reply.code(403).send({ error: 'Project access required' });
    return projectQAState(store, id);
  });
  app.post('/projects/:id/qa/issues/:issueId/decision', async (request, reply) => {
    const { id, issueId } = z
      .object({ id: z.string().min(1), issueId: z.string().min(1) })
      .parse(request.params);
    if (!(await allowed(request, id, 'code')))
      return reply.code(403).send({ error: 'Permission to work with code required' });
    const { decision } = z
      .object({ decision: z.enum(['another_round', 'take_over', 'defer']) })
      .strict()
      .parse(request.body);
    if (!(await store.repairs.qa()).enabled)
      return reply.code(409).send({ error: 'QA is switched off in system settings' });
    if (!(await store.repairs.projectQA.decide(id, issueId, decision)))
      return reply
        .code(409)
        .send({ error: 'This issue no longer waits for a decision. Refresh QA.' });
    changed(id);
    return { state: await projectQAState(store, id) };
  });
  app.post('/settings/qa/brake/release', async (request, reply) => {
    if (!request.localUserId || !(await store.isActiveAdministrator(request.localUserId)))
      return reply.code(403).send({ error: 'Administrator access required' });
    await store.repairs.projectQA.releaseBrake();
    return { brakeAt: null };
  });
}
