import { randomUUID } from 'node:crypto';
import { qaAnalysisRequestSchema } from '@verity/events';
import type { ProjectRecord } from '@verity/store';
import type { AssistantToolDeps } from './assistant-tool.js';
import type { QARepositoryRequest } from './github-qa-analysis.js';
import { ControlPlaneSessionAuthorityError } from './session-handoff-tool.js';
type Report = {
  sessionId: string;
  userId: string | undefined;
  projectId: string;
  expires: number;
  data: Record<string, unknown>;
};
const reports = new WeakMap<AssistantToolDeps['eventStore'], Map<string, Report>>();
export interface QAAnalysisDeps extends AssistantToolDeps {
  saveReport?(
    this: void,
    projectId: string,
    id: string,
    report: Record<string, unknown>,
    authorize: () => Promise<void>,
  ): Promise<unknown>;
  read(
    this: void,
    project: ProjectRecord,
    request: QARepositoryRequest,
    authorize: () => Promise<void>,
  ): Promise<Record<string, unknown>>;
}
export async function executeQAAnalysis(
  deps: QAAnalysisDeps,
  input: { sessionId: string; turnId: string; request: unknown },
) {
  const request = qaAnalysisRequestSchema.parse(input.request);
  const requireRole = async () => {
    const qa = await deps.eventStore.repairs.qa();
    if (!qa.enabled || qa.session_id !== input.sessionId)
      throw new ControlPlaneSessionAuthorityError(
        'QA analysis is disabled or unavailable to this session.',
      );
    return qa;
  };
  await requireRole();
  const authorize = async (projectId: string) => {
    await requireRole();
    const user = await deps.initiator(input.sessionId, input.turnId);
    // Interactive reads never borrow the background sponsor's authority.
    const mandate = await deps.eventStore.repairs.mandate(projectId);
    const project = await deps.eventStore.getProject(projectId);
    if (
      !mandate ||
      mandate.mode === 'off' ||
      !project ||
      project.hiddenAt !== null ||
      project.archived ||
      !(await deps.permitted(user?.userId, projectId, 'read'))
    )
      throw new ControlPlaneSessionAuthorityError('QA has no current read access to this project.');
    return project;
  };
  if (request.action === 'projects') {
    const projects = [];
    for (const mandate of await deps.eventStore.repairs.mandates()) {
      try {
        const p = await authorize(mandate.project_id);
        projects.push({
          projectId: p.id,
          name: `${p.owner}/${p.repo}`,
          provider: p.kind,
          mode: mandate.mode,
          health: mandate.health,
          diagnostic: mandate.observation_error,
          checkedAt: mandate.checked_at,
        });
      } catch (error) {
        if (!(error instanceof ControlPlaneSessionAuthorityError)) throw error;
      }
    }
    await requireRole();
    return { projects };
  }
  const project = await authorize(request.projectId);
  const userId = (await deps.initiator(input.sessionId, input.turnId))?.userId;
  let cache = reports.get(deps.eventStore);
  if (!cache) {
    cache = new Map();
    reports.set(deps.eventStore, cache);
  }
  for (const [id, r] of cache) if (r.expires < Date.now()) cache.delete(id);
  if (request.action === 'save_report') {
    const report = cache.get(request.reportId);
    if (
      !report ||
      report.sessionId !== input.sessionId ||
      report.userId !== userId ||
      report.projectId !== project.id
    )
      throw new Error('Report expired or unavailable; calculate statistics again');
    const check = async () => {
      await authorize(project.id);
      if (
        !(await deps.permitted(
          (await deps.initiator(input.sessionId, input.turnId))?.userId,
          project.id,
          'execute',
        ))
      )
        throw new ControlPlaneSessionAuthorityError(
          'Saving a report requires project execution permission',
        );
    };
    await check();
    if (!deps.saveReport) throw new Error('Document storage unavailable');
    const saved = await deps.saveReport(project.id, request.reportId, report.data, check);
    return { saved };
  }
  const result = await deps.read(project, request, async () => {
    await authorize(request.projectId);
  });
  await authorize(request.projectId);
  if (request.action === 'statistics' && 'groups' in result && !result.continuation) {
    const reportId = randomUUID();
    if (cache.size >= 20) cache.delete(cache.keys().next().value!);
    cache.set(reportId, {
      sessionId: input.sessionId,
      userId,
      projectId: project.id,
      expires: Date.now() + 3600000,
      data: result,
    });
    return { ...result, reportId };
  }
  return result;
}
