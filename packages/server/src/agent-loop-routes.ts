// Agent Loop CRUD and validation routes (ADR 0008). Loops are always created as
// drafts. A successful server-executed test marks the exact current script as
// proven; only then may PATCH move the loop to `enabled`.
import {
  AgentLoopNotReadyError,
  MIN_INTERVAL_MINUTES,
  type AgentLoopPatch,
  type AgentLoopRecord,
  type EventStore,
  type ScheduleConfig,
} from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const scheduleSchema: z.ZodType<ScheduleConfig> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('interval'),
    everyMinutes: z.number().int().min(MIN_INTERVAL_MINUTES),
  }),
  z.object({
    kind: z.literal('daily'),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  z.object({
    kind: z.literal('weekly'),
    weekday: z.number().int().min(0).max(6),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
]);

const nullableTrimmed = z.string().trim().min(1).nullable();
const projectReactionModel = nullableTrimmed.refine(
  (model) => model === null || !model.includes('/') || model.startsWith('codex/'),
  'project Agent Loops currently support Claude and Codex models only',
);
const createBody = z.object({
  name: z.string().trim().min(1).max(200),
  schedule: scheduleSchema.nullable().optional(),
  script: nullableTrimmed.optional(),
  reactionPrompt: nullableTrimmed.optional(),
  reactionModel: projectReactionModel.optional(),
});
const patchBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  status: z.enum(['draft', 'enabled', 'paused']).optional(),
  schedule: scheduleSchema.nullable().optional(),
  script: nullableTrimmed.optional(),
  reactionPrompt: nullableTrimmed.optional(),
  reactionModel: projectReactionModel.optional(),
});
const projectParams = z.object({ projectId: z.string().min(1) });
const loopParams = z.object({ loopId: z.string().min(1) });
const deleteQuery = z.object({ deleteSession: z.enum(['true', 'false']).optional() });

export interface AgentLoopTestResult {
  outcome: 'ok' | 'acted' | 'error';
  exitCode: number | null;
  detail: string | null;
  sessionId: string | null;
}

export interface AgentLoopRunResult {
  outcome: 'ok' | 'acted' | 'error' | 'skipped';
  exitCode: number | null;
  detail: string | null;
  sessionId: string | null;
}

export function registerAgentLoopRoutes(
  app: FastifyInstance,
  deps: {
    eventStore: EventStore;
    createLoopSession?: (
      loop: AgentLoopRecord,
      project: NonNullable<Awaited<ReturnType<EventStore['getProject']>>>,
    ) => Promise<{ sessionId: string }>;
    testAgentLoop?: (loop: AgentLoopRecord) => Promise<AgentLoopTestResult>;
    runAgentLoop?: (loop: AgentLoopRecord) => Promise<AgentLoopRunResult>;
    deleteLoopSession?: (sessionId: string) => Promise<'deleted' | 'missing' | 'busy'>;
    /** Cleanup for a newly created session that lost an atomic link race. Unlike
     * user deletion this must close a seeded/busy session unconditionally. */
    discardLoopSession?: (
      sessionId: string,
      project: NonNullable<Awaited<ReturnType<EventStore['getProject']>>>,
    ) => Promise<void>;
    onAgentLoopsChanged?: () => void;
  },
): void {
  const changed = (): void => deps.onAgentLoopsChanged?.();

  app.get('/projects/:projectId/agent-loops', async (request, reply) => {
    const { projectId } = projectParams.parse(request.params);
    const project = await deps.eventStore.getProject(projectId);
    if (project === undefined) {
      reply.code(404);
      return { error: 'project not found' };
    }
    return { loops: await deps.eventStore.listAgentLoops(projectId) };
  });

  app.post('/projects/:projectId/agent-loops', async (request, reply) => {
    const { projectId } = projectParams.parse(request.params);
    const body = createBody.parse(request.body);
    const project = await deps.eventStore.getProject(projectId);
    if (project === undefined) {
      reply.code(404);
      return { error: 'project not found' };
    }
    if (!deps.createLoopSession) {
      reply.code(503);
      return { error: 'Agent Loop session creation is not configured' };
    }
    let loop = await deps.eventStore.createAgentLoop({
      projectId,
      name: body.name,
      ...(body.schedule !== undefined ? { schedule: body.schedule } : {}),
      ...(body.script !== undefined ? { script: body.script } : {}),
      ...(body.reactionPrompt !== undefined ? { reactionPrompt: body.reactionPrompt } : {}),
      ...(body.reactionModel !== undefined ? { reactionModel: body.reactionModel } : {}),
    });
    try {
      const { sessionId } = await deps.createLoopSession(loop, project);
      const linked = await deps.eventStore.linkAgentLoopSessionIfMissing(loop.id, sessionId);
      if (!linked) {
        if (deps.discardLoopSession) await deps.discardLoopSession(sessionId, project);
        else await deps.deleteLoopSession?.(sessionId);
        throw new Error('Agent Loop disappeared while its session was being created');
      }
      loop = linked;
    } catch (error) {
      await deps.eventStore.deleteAgentLoop(loop.id);
      throw error;
    }
    changed();
    reply.code(201);
    return { loop };
  });

  app.get('/agent-loops/:loopId', async (request, reply) => {
    const { loopId } = loopParams.parse(request.params);
    const loop = await deps.eventStore.getAgentLoop(loopId);
    if (!loop) {
      reply.code(404);
      return { error: 'Agent Loop not found' };
    }
    return { loop };
  });

  app.patch('/agent-loops/:loopId', async (request, reply) => {
    const { loopId } = loopParams.parse(request.params);
    const body = patchBody.parse(request.body ?? {});
    const patch: AgentLoopPatch = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.status !== undefined) patch.status = body.status;
    if (body.schedule !== undefined) patch.schedule = body.schedule;
    if (body.script !== undefined) patch.script = body.script;
    if (body.reactionPrompt !== undefined) patch.reactionPrompt = body.reactionPrompt;
    if (body.reactionModel !== undefined) patch.reactionModel = body.reactionModel;
    try {
      const loop = await deps.eventStore.updateAgentLoop(loopId, patch);
      if (!loop) {
        reply.code(404);
        return { error: 'Agent Loop not found' };
      }
      if (body.name !== undefined && loop.sessionId) {
        await deps.eventStore.renameSession(loop.sessionId, `Agent Loop: ${body.name}`);
      }
      changed();
      return { loop };
    } catch (error) {
      if (error instanceof AgentLoopNotReadyError) {
        reply.code(409);
        return { error: error.message, code: 'agentLoopNotReady' };
      }
      throw error;
    }
  });

  app.post('/agent-loops/:loopId/session', async (request, reply) => {
    const { loopId } = loopParams.parse(request.params);
    let loop = await deps.eventStore.getAgentLoop(loopId);
    if (!loop) {
      reply.code(404);
      return { error: 'Agent Loop not found' };
    }
    if (loop.sessionId) return { loop };
    if (!deps.createLoopSession) {
      reply.code(503);
      return { error: 'Agent Loop session creation is not configured' };
    }
    const project = await deps.eventStore.getProject(loop.projectId);
    if (!project) {
      reply.code(404);
      return { error: 'project not found' };
    }
    const { sessionId } = await deps.createLoopSession(loop, project);
    const linked = await deps.eventStore.linkAgentLoopSessionIfMissing(loop.id, sessionId);
    if (!linked) {
      if (deps.discardLoopSession) await deps.discardLoopSession(sessionId, project);
      else await deps.deleteLoopSession?.(sessionId);
      const winner = await deps.eventStore.getAgentLoop(loop.id);
      if (winner?.sessionId) return { loop: winner };
      reply.code(409);
      return { error: 'Agent Loop changed while its session was being created' };
    }
    loop = linked;
    changed();
    return { loop };
  });

  app.post('/agent-loops/:loopId/test', async (request, reply) => {
    const { loopId } = loopParams.parse(request.params);
    const loop = await deps.eventStore.getAgentLoop(loopId);
    if (!loop) {
      reply.code(404);
      return { error: 'Agent Loop not found' };
    }
    if (!deps.testAgentLoop) {
      reply.code(503);
      return { error: 'Agent Loop execution is not configured' };
    }
    const run = await deps.eventStore.startAgentLoopRun(loop.id);
    let result: AgentLoopTestResult;
    try {
      result = await deps.testAgentLoop(loop);
    } catch (error) {
      await deps.eventStore.finishAgentLoopRun(run.id, {
        outcome: 'error',
        exitCode: null,
        detail: error instanceof Error ? error.message : 'Agent Loop test failed',
        sessionId: null,
        isTest: true,
      });
      throw error;
    }
    await deps.eventStore.finishAgentLoopRun(run.id, { ...result, isTest: true });
    if (result.outcome === 'ok' || result.outcome === 'acted') {
      const testedLoop = await deps.eventStore.markAgentLoopTestPassed(loop.id, loop);
      if (!testedLoop) {
        reply.code(409);
        return {
          error: 'Agent Loop changed during its test; test the current config again',
          code: 'agentLoopChangedDuringTest',
        };
      }
      return { result, loop: testedLoop };
    }
    return { result, loop: await deps.eventStore.getAgentLoop(loop.id) };
  });

  app.post('/agent-loops/:loopId/run', async (request, reply) => {
    const { loopId } = loopParams.parse(request.params);
    const loop = await deps.eventStore.getAgentLoop(loopId);
    if (!loop) {
      reply.code(404);
      return { error: 'Agent Loop not found' };
    }
    if (!loop.testedScriptFingerprint) {
      reply.code(409);
      return {
        error: 'Test the current Agent Loop config before running it',
        code: 'agentLoopNotReady',
      };
    }
    if (!deps.runAgentLoop) {
      reply.code(503);
      return { error: 'Agent Loop execution is not configured' };
    }
    const run = await deps.eventStore.startAgentLoopRun(loop.id);
    let result: AgentLoopRunResult;
    try {
      result = await deps.runAgentLoop(loop);
    } catch (error) {
      result = {
        outcome: 'error',
        exitCode: null,
        detail: error instanceof Error ? error.message : String(error),
        sessionId: loop.sessionId,
      };
    }
    await deps.eventStore.finishAgentLoopRun(run.id, result);
    const finishedRun = await deps.eventStore.getAgentLoopRun(run.id);
    const updatedLoop = await deps.eventStore.getAgentLoop(loop.id);
    if (!finishedRun || !updatedLoop) {
      reply.code(409);
      return { error: 'Agent Loop changed while it was running' };
    }
    return {
      result,
      run: finishedRun,
      loop: updatedLoop,
    };
  });

  app.delete('/agent-loops/:loopId', async (request, reply) => {
    const { loopId } = loopParams.parse(request.params);
    const { deleteSession: deleteSessionParam } = deleteQuery.parse(request.query);
    const deleteSession = deleteSessionParam === 'true';
    const loop = await deps.eventStore.getAgentLoop(loopId);
    if (!loop) {
      reply.code(404);
      return { error: 'Agent Loop not found' };
    }
    if (deleteSession && loop.sessionId) {
      if (!deps.deleteLoopSession) {
        reply.code(503);
        return { error: 'Agent Loop session deletion is not configured' };
      }
      const sessionResult = await deps.deleteLoopSession(loop.sessionId);
      if (sessionResult === 'busy') {
        reply.code(409);
        return { error: 'Agent Loop session is busy' };
      }
    }
    await deps.eventStore.deleteAgentLoop(loopId);
    changed();
    return { ok: true };
  });

  app.get('/agent-loops/:loopId/runs', async (request, reply) => {
    const { loopId } = loopParams.parse(request.params);
    if ((await deps.eventStore.getAgentLoop(loopId)) === undefined) {
      reply.code(404);
      return { error: 'Agent Loop not found' };
    }
    return { runs: await deps.eventStore.listAgentLoopRuns(loopId) };
  });
}
