import { createHash } from 'node:crypto';
import { isSessionLinkProject, type EventStore, type ProjectRecord } from '@verity/store';
import { sessionCoordinationRequestSchema } from './session-coordination-request.js';

export interface CoordinationRequestReceipt {
  phase: 'reserved' | 'created' | 'linked' | 'delivered';
  result?: Record<string, unknown>;
}

export interface SessionCoordinationDeps {
  store: Pick<
    EventStore,
    | 'getProject'
    | 'getSession'
    | 'listProjects'
    | 'listSessions'
    | 'createSessionLink'
    | 'listSessionLinks'
    | 'projectInquiries'
  >;
  authorized(userId: string | null, projectId: string): Promise<boolean>;
  spawn(projectId: string, sessionId: string, name: string, userId: string | null): Promise<void>;
  deliver(input: {
    sourceSessionId: string;
    targetSessionId: string;
    message: string;
    invocationId: string;
    userId: string | null;
    approvedByCard: boolean;
  }): Promise<Record<string, unknown>>;
  readProgress(sessionId: string): Promise<{
    summary?: string;
    updatedAt?: string;
    stale?: boolean;
  }>;
  status(sessionId: string): string;
  requests: {
    claim(
      sourceSessionId: string,
      requestId: string,
      fingerprint: string,
      targetSessionId: string,
    ): Promise<CoordinationRequestReceipt>;
    update(
      sourceSessionId: string,
      requestId: string,
      receipt: CoordinationRequestReceipt,
    ): Promise<void>;
  };
}

/** Coordination never treats knowledge, peer text, or a link as execution authority. */
export function createSessionCoordination(deps: SessionCoordinationDeps) {
  const locks = new Map<string, Promise<unknown>>();
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  async function available(userId: string | null, projectId: string): Promise<ProjectRecord> {
    const project = await deps.store.getProject(projectId);
    if (!project || !isSessionLinkProject(project) || !(await deps.authorized(userId, projectId)))
      throw new Error('Project is unavailable or not permitted');
    return project;
  }
  async function sourceProject(sourceSessionId: string, userId: string | null): Promise<string> {
    const source = await deps.store.getSession(sourceSessionId);
    if (!source?.projectId) throw new Error('Source session is unavailable');
    await available(userId, source.projectId);
    return source.projectId;
  }
  async function target(
    sourceSessionId: string,
    userId: string | null,
    targetProjectId: string,
    targetSessionId: string,
  ) {
    await sourceProject(sourceSessionId, userId);
    await available(userId, targetProjectId);
    const session = await deps.store.getSession(targetSessionId);
    if (
      !session ||
      session.projectId !== targetProjectId ||
      targetSessionId === sourceSessionId ||
      (await deps.store.projectInquiries.isTarget(targetSessionId))
    )
      throw new Error('Target session is unavailable');
  }
  return async (input: {
    sourceSessionId: string;
    userId: string | null;
    request: unknown;
    approvedByCard?: boolean;
    validateCaller?: () => Promise<void>;
  }) => {
    await input.validateCaller?.();
    const { sourceSessionId, userId } = input;
    const request = sessionCoordinationRequestSchema.parse(input.request);
    const sourceProjectId = await sourceProject(sourceSessionId, userId);
    const validateSource = async () => {
      await input.validateCaller?.();
      if ((await sourceProject(sourceSessionId, userId)) !== sourceProjectId)
        throw new Error('Source session project changed');
    };
    if (request.operation === 'discover') {
      const limit = request.limit ?? 20;
      const query = request.query?.toLocaleLowerCase();
      const sessionOffset = request.sessionOffset ?? 0;
      const projectOffset = request.projectOffset ?? 0;
      const projects = [];
      for (const project of await deps.store.listProjects()) {
        if (request.targetProjectId && project.id !== request.targetProjectId) continue;
        if (!isSessionLinkProject(project) || !(await deps.authorized(userId, project.id)))
          continue;
        projects.push(project);
      }
      if (request.targetProjectId && projects.length === 0)
        throw new Error('Project is unavailable or not permitted');
      const allowed = new Map(projects.map((project) => [project.id, project]));
      const candidates = (await deps.store.listSessions()).filter(
        (session) =>
          session.sessionId !== sourceSessionId &&
          session.projectId &&
          allowed.has(session.projectId),
      );
      const sessions = [];
      // Bound summary reads even when a project contains thousands of sessions.
      const scanLimit = 200;
      let scanned = 0;
      for (const session of candidates.slice(sessionOffset, sessionOffset + scanLimit)) {
        scanned++;
        if (await deps.store.projectInquiries.isTarget(session.sessionId)) continue;
        const project = allowed.get(session.projectId!)!;
        const progress = await deps.readProgress(session.sessionId);
        const summary = progress.summary?.slice(0, 1000);
        const haystack = [session.name, project.name, project.repo, summary]
          .join(' ')
          .toLocaleLowerCase();
        if (query && !haystack.includes(query)) continue;
        // Recheck after summary reads: revocation or a move must not disclose metadata.
        await validateSource();
        await target(sourceSessionId, userId, project.id, session.sessionId);
        sessions.push({
          sessionId: session.sessionId,
          name: session.name,
          projectId: project.id,
          projectName: project.name || project.repo,
          status: deps.status(session.sessionId),
          progress: summary
            ? { summary, updatedAt: progress.updatedAt ?? null, stale: progress.stale ?? true }
            : { summary: null, stale: true },
        });
        if (sessions.length === limit) break;
      }
      const nextSessionOffset =
        sessionOffset + scanned < candidates.length ? sessionOffset + scanned : null;
      // Project discovery is separate from session-topic matching, so an empty project remains findable.
      const matchingProjects = projects.filter(
        (project) =>
          !query || [project.name, project.repo].join(' ').toLocaleLowerCase().includes(query),
      );
      const projectPage = matchingProjects.slice(projectOffset, projectOffset + limit);
      const nextProjectOffset =
        projectOffset + projectPage.length < matchingProjects.length
          ? projectOffset + projectPage.length
          : null;
      await validateSource();
      for (const project of projectPage) await available(userId, project.id);
      for (const session of sessions)
        await target(sourceSessionId, userId, session.projectId, session.sessionId);
      await validateSource();
      return {
        projects: projectPage.map((project) => ({
          projectId: project.id,
          name: project.name || project.repo,
          kind: project.kind,
          state: project.state,
        })),
        sessions: sessions.slice(0, limit),
        hasMore: nextSessionOffset !== null || nextProjectOffset !== null,
        nextSessionOffset,
        nextProjectOffset,
        scanTruncated: scanned === scanLimit && nextSessionOffset !== null,
        selectionRequired: sessions.length > 1,
      };
    }
    const key = `${sourceSessionId}:${request.requestId}`;
    const previous = locks.get(key) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        // Explicit fields fix the hash across harmless JSON key-order differences.
        const canonical =
          request.operation === 'start'
            ? ['start', request.targetProjectId, request.name, request.message]
            : ['link', request.targetProjectId, request.targetSessionId, request.message ?? null];
        const fingerprint = hash(JSON.stringify(canonical));
        const digest = hash(`session-coordinate:${sourceSessionId}:${request.requestId}`);
        const targetSessionId =
          request.operation === 'start'
            ? `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`
            : request.targetSessionId;
        await validateSource();
        await available(userId, request.targetProjectId);
        const receipt = await deps.requests.claim(
          sourceSessionId,
          request.requestId,
          fingerprint,
          targetSessionId,
        );
        if (request.operation === 'start') {
          const existing = await deps.store.getSession(targetSessionId);
          if (!existing) {
            if (receipt.phase !== 'reserved') throw new Error('Created target session was deleted');
            await validateSource();
            await available(userId, request.targetProjectId);
            await validateSource();
            await deps.spawn(request.targetProjectId, targetSessionId, request.name, userId);
          }
          await validateSource();
          await target(sourceSessionId, userId, request.targetProjectId, targetSessionId);
          if (receipt.phase === 'reserved')
            await deps.requests.update(sourceSessionId, request.requestId, {
              phase: 'created',
              // Kept through later phases, so the header can tell a handover from a question.
              result: { created: true },
            });
        }
        await validateSource();
        await target(sourceSessionId, userId, request.targetProjectId, targetSessionId);
        if (receipt.phase === 'linked' || receipt.phase === 'delivered') {
          const links = await deps.store.listSessionLinks(sourceSessionId);
          if (!links.some((link) => link.peerSessionId === targetSessionId))
            throw new Error('Session link was revoked');
        }
        if (receipt.phase === 'delivered')
          return { ...receipt.result, targetSessionId, created: request.operation === 'start' };
        await validateSource();
        await deps.store.createSessionLink(sourceSessionId, targetSessionId, request.requestId);
        const result: Record<string, unknown> = {
          targetSessionId,
          created: request.operation === 'start',
          linked: true,
        };
        if (request.message) {
          await validateSource();
          await target(sourceSessionId, userId, request.targetProjectId, targetSessionId);
          await validateSource();
          const delivery = await deps.deliver({
            sourceSessionId,
            targetSessionId,
            message: request.message,
            invocationId: hash(`session-coordinate-delivery:${key}`),
            userId,
            approvedByCard: input.approvedByCard === true,
          });
          result.delivery = delivery;
          if (delivery.status === 'approval_required' || delivery.status === 'blocked')
            return { ...result, status: delivery.status };
        }
        await deps.requests.update(sourceSessionId, request.requestId, {
          phase: 'delivered',
          result,
        });
        return result;
      });
    locks.set(key, operation);
    try {
      return await operation;
    } finally {
      if (locks.get(key) === operation) locks.delete(key);
    }
  };
}
