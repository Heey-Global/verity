// Dev-server CRUD and runtime routes. A project may have one-or-more named preview
// processes, each addressed by its stable `dev_servers.id`.
import { createHash } from 'node:crypto';
import {
  DevServerPortRangeExhaustedError,
  type DevServerPatch,
  type EventStore,
  type ProjectRecord,
} from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DevServerSuggestion } from './dev-server-detection.js';
import { containerPathFor } from './project-backend.js';
import type { ProjectRuntime, ProjectRuntimeSettings } from './project-runtime.js';
import { projectClonePath } from './provisioner.js';

// Text fields accept null or any string (the store trims and collapses empties to
// null); ports accept digits or empty (→ null).
const text = z.string().nullable().optional();
const port = z.string().regex(/^\d*$/, 'must be a port number').nullable().optional();

const createBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    sourceKey: z.string().trim().min(1).max(500).nullable().optional(),
    command: text,
    url: text,
    workdir: text,
    containerPort: port,
    autoStart: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();
const patchBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    command: text,
    url: text,
    workdir: text,
    containerPort: port,
    autoStart: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();
const projectParams = z.object({ projectId: z.string().min(1) });
const devServerParams = z.object({ devServerId: z.string().min(1) });
const reviewDetectionBody = z.object({ fingerprint: z.string().min(1) }).strict();
const previewSessionBody = z.object({ sessionId: z.string().min(1).nullable() }).strict();

export function registerDevServerRoutes(
  app: FastifyInstance,
  deps: {
    eventStore: EventStore;
    projectRuntime?: ProjectRuntime;
    detectDevServers?: (
      project: NonNullable<Awaited<ReturnType<EventStore['getProject']>>>,
    ) => Promise<DevServerSuggestion[]>;
    onDevServersChanged?: () => void;
    /** Host root the project clones live under; required to resolve a preview
     *  session's worktree to its in-container path. Absent → previews disabled. */
    projectCloneRoot?: string;
    /** Synchronize the managed main checkout before returning a preview to it. */
    syncProjectCheckout?: (projectId: string) => Promise<void>;
    /** Revoke links and hold their lifecycle fence until the target mutation ends. */
    beginPublicPreviewMutation?: (devServerId: string) => Promise<() => void>;
  },
): void {
  const changed = (): void => deps.onDevServersChanged?.();
  const withPreviewMutation = async <T>(
    devServerId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const release = await deps.beginPublicPreviewMutation?.(devServerId);
    try {
      return await operation();
    } finally {
      release?.();
    }
  };

  // The in-container checkout root for a previewed session's worktree, or null
  // to serve the main checkout. Resolution is lazy and forgiving: a dangling
  // pointer (session gone, moved project, worktree outside the clone) falls back
  // to main instead of failing every runtime call.
  const previewCheckoutRoot = async (
    devServer: { previewSessionId: string | null },
    project: ProjectRecord,
  ): Promise<string | null> => {
    if (devServer.previewSessionId === null || !deps.projectCloneRoot) return null;
    const session = await deps.eventStore.getSession(devServer.previewSessionId);
    if (!session || session.projectId !== project.id) return null;
    try {
      return containerPathFor(session.worktree, projectClonePath(deps.projectCloneRoot, project));
    } catch {
      return null;
    }
  };

  const runtimeTarget = async (devServerId: string, decryptSecrets = false) => {
    const devServer = await deps.eventStore.getDevServer(devServerId);
    if (!devServer) return undefined;
    const project = await deps.eventStore.getProject(devServer.projectId);
    if (!project || project.hiddenAt !== null) return undefined;
    const projectSettings = decryptSecrets
      ? await deps.eventStore.getProjectSettings(project.id)
      : await deps.eventStore.getProjectSettingsRaw(project.id);
    const firstDevServer = (await deps.eventStore.listDevServers(project.id))[0];
    const settings: ProjectRuntimeSettings = {
      defaultBranch: projectSettings?.defaultBranch ?? null,
      defaultModel: projectSettings?.defaultModel ?? null,
      devServerId: devServer.id,
      adoptLegacyDevServerFiles: firstDevServer?.id === devServer.id,
      devServerCommand: devServer.command,
      devServerUrl: devServer.url,
      devServerWorkdir: devServer.workdir,
      devServerHostPort: devServer.hostPort,
      devServerContainerPort: devServer.containerPort,
      devServerCheckoutRoot: await previewCheckoutRoot(devServer, project),
    };
    return { devServer, project, settings };
  };

  const requireRuntimeTarget = async (
    devServerId: string,
    reply: { code(status: number): void },
    requireActive = true,
  ) => {
    if (!deps.projectRuntime) {
      reply.code(503);
      return { error: 'project runtime is not configured' } as const;
    }
    const target = await runtimeTarget(devServerId);
    if (!target) {
      reply.code(404);
      return { error: 'dev server not found' } as const;
    }
    if (
      (requireActive && target.project.state !== 'active') ||
      (!requireActive && target.project.state === 'absent')
    ) {
      reply.code(409);
      return { error: `project ${target.project.id} is not active` } as const;
    }
    return { target, runtime: deps.projectRuntime } as const;
  };

  app.get('/projects/:projectId/dev-servers', async (request, reply) => {
    const { projectId } = projectParams.parse(request.params);
    const project = await deps.eventStore.getProject(projectId);
    if (project === undefined || project.hiddenAt !== null) {
      reply.code(404);
      return { error: 'project not found' };
    }
    const servers = await deps.eventStore.listDevServers(projectId);
    const devServers = await Promise.all(
      servers.map(async (server) => {
        if (!deps.projectRuntime || project.state !== 'active')
          return { ...server, running: false };
        const target = await runtimeTarget(server.id);
        if (!target) return { ...server, running: false };
        try {
          const status = await deps.projectRuntime.devServerStatus(target.project, target.settings);
          return { ...server, running: status.running };
        } catch {
          return { ...server, running: false };
        }
      }),
    );
    return { devServers };
  });

  app.get('/projects/:projectId/dev-server-suggestions', async (request, reply) => {
    const { projectId } = projectParams.parse(request.params);
    const project = await deps.eventStore.getProject(projectId);
    if (!project || project.hiddenAt !== null) {
      reply.code(404);
      return { error: 'project not found' };
    }
    if (!deps.detectDevServers) {
      reply.code(503);
      return { error: 'dev server detection is not configured' };
    }
    const existing = await deps.eventStore.listDevServers(projectId);
    const detected = await deps.detectDevServers(project);
    const detectedKeys = new Set(detected.map(({ key }) => key));
    const suggestions = [];
    for (const suggestion of detected) {
      const tracked = existing.find((server) => server.sourceKey === suggestion.key);
      // Preserve the old exact-match display for pre-sourceKey/manual rows without
      // silently making them detector-owned. Only an explicitly-created detected
      // server may later become `missing`.
      const untrackedExact = tracked
        ? undefined
        : existing.find(
            (server) =>
              server.sourceKey === null &&
              server.workdir === suggestion.workdir &&
              server.command === suggestion.command,
          );
      const match = tracked ?? untrackedExact;
      const status = !match
        ? ('new' as const)
        : !tracked ||
            (match.name === suggestion.name &&
              match.command === suggestion.command &&
              match.workdir === suggestion.workdir &&
              match.containerPort === suggestion.containerPort)
          ? ('configured' as const)
          : ('changed' as const);
      suggestions.push({
        ...suggestion,
        status,
        alreadyConfigured: match !== undefined,
        existingDevServerId: match?.id ?? null,
        existingConfig: match ? detectionComparableConfig(match) : null,
      });
    }
    for (const server of existing) {
      if (!server.sourceKey || detectedKeys.has(server.sourceKey)) continue;
      suggestions.push({
        key: server.sourceKey,
        name: server.name,
        command: server.command ?? '',
        workdir: server.workdir,
        containerPort: server.containerPort,
        confidence: 'low' as const,
        evidence: 'The previously detected repository script was not found.',
        status: 'missing' as const,
        alreadyConfigured: true,
        existingDevServerId: server.id,
        existingConfig: detectionComparableConfig(server),
      });
    }
    const fingerprint = devServerDetectionFingerprint(suggestions);
    const state = await deps.eventStore.recordDevServerDetection(projectId, fingerprint);
    return {
      fingerprint,
      detectedAt: state.detectedAt,
      reviewedFingerprint: state.reviewedFingerprint,
      reviewedAt: state.reviewedAt,
      suggestions,
    };
  });

  app.post('/projects/:projectId/dev-server-suggestions/reviewed', async (request, reply) => {
    const { projectId } = projectParams.parse(request.params);
    const { fingerprint } = reviewDetectionBody.parse(request.body ?? {});
    const project = await deps.eventStore.getProject(projectId);
    if (!project || project.hiddenAt !== null) {
      reply.code(404);
      return { error: 'project not found' };
    }
    const state = await deps.eventStore.reviewDevServerDetection(projectId, fingerprint);
    if (!state) {
      reply.code(409);
      return { error: 'detection result is stale' };
    }
    return {
      detection: {
        fingerprint: state.fingerprint,
        detectedAt: state.detectedAt,
        reviewedFingerprint: state.reviewedFingerprint,
        reviewedAt: state.reviewedAt,
      },
    };
  });

  app.post('/projects/:projectId/dev-servers', async (request, reply) => {
    const { projectId } = projectParams.parse(request.params);
    const body = createBody.parse(request.body ?? {});
    const project = await deps.eventStore.getProject(projectId);
    if (project === undefined) {
      reply.code(404);
      return { error: 'project not found' };
    }
    if (project.hiddenAt !== null) {
      reply.code(404);
      return { error: 'project not found' };
    }
    if (project.state !== 'absent') {
      reply.code(409);
      return { error: 'pause the project environment before adding a dev server' };
    }
    let devServer;
    try {
      devServer = await deps.eventStore.createDevServer({
        projectId,
        ...(body.sourceKey !== undefined ? { sourceKey: body.sourceKey } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.command !== undefined ? { command: body.command } : {}),
        ...(body.url !== undefined ? { url: body.url } : {}),
        ...(body.workdir !== undefined ? { workdir: body.workdir } : {}),
        ...(body.containerPort !== undefined ? { containerPort: body.containerPort } : {}),
        ...(body.autoStart !== undefined ? { autoStart: body.autoStart } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      });
    } catch (error) {
      if (error instanceof DevServerPortRangeExhaustedError) {
        reply.code(409);
        return { error: error.message };
      }
      throw error;
    }
    changed();
    reply.code(201);
    return { devServer };
  });

  app.get('/dev-servers/:devServerId', async (request, reply) => {
    const { devServerId } = devServerParams.parse(request.params);
    const devServer = await deps.eventStore.getDevServer(devServerId);
    if (!devServer) {
      reply.code(404);
      return { error: 'dev server not found' };
    }
    const project = await deps.eventStore.getProject(devServer.projectId);
    if (!project || project.hiddenAt !== null) {
      reply.code(404);
      return { error: 'dev server not found' };
    }
    return { devServer };
  });

  app.patch('/dev-servers/:devServerId', async (request, reply) => {
    const { devServerId } = devServerParams.parse(request.params);
    const body = patchBody.parse(request.body ?? {});
    const current = await deps.eventStore.getDevServer(devServerId);
    if (!current) {
      reply.code(404);
      return { error: 'dev server not found' };
    }
    const project = await deps.eventStore.getProject(current.projectId);
    if (!project || project.hiddenAt !== null) {
      reply.code(404);
      return { error: 'project not found' };
    }
    if (body.containerPort !== undefined) {
      if (project.state !== 'absent') {
        reply.code(409);
        return { error: 'pause the project environment before changing its published port' };
      }
    }
    const changesRunningProcess =
      body.command !== undefined || body.workdir !== undefined || body.containerPort !== undefined;
    if (changesRunningProcess && deps.projectRuntime) {
      const target = await runtimeTarget(devServerId);
      if (target && target.project.state === 'active') {
        const status = await deps.projectRuntime.devServerStatus(target.project, target.settings);
        if (status.running) {
          reply.code(409);
          return { error: 'stop the dev server before changing its runtime configuration' };
        }
      }
    }
    const patch: DevServerPatch = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.command !== undefined) patch.command = body.command;
    if (body.url !== undefined) patch.url = body.url;
    if (body.workdir !== undefined) patch.workdir = body.workdir;
    if (body.containerPort !== undefined) patch.containerPort = body.containerPort;
    if (body.autoStart !== undefined) patch.autoStart = body.autoStart;
    if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder;
    const devServer = await (changesRunningProcess
      ? withPreviewMutation(devServerId, () => deps.eventStore.updateDevServer(devServerId, patch))
      : deps.eventStore.updateDevServer(devServerId, patch));
    if (!devServer) {
      reply.code(404);
      return { error: 'dev server not found' };
    }
    changed();
    return { devServer };
  });

  app.delete('/dev-servers/:devServerId', async (request, reply) => {
    const { devServerId } = devServerParams.parse(request.params);
    const target = await runtimeTarget(devServerId);
    if (!target) {
      reply.code(404);
      return { error: 'dev server not found' };
    }
    return withPreviewMutation(devServerId, async () => {
      if (target.project.state !== 'absent') {
        if (!deps.projectRuntime) {
          reply.code(503);
          return { error: 'project runtime is not configured; cannot safely delete dev server' };
        }
        await deps.projectRuntime.stopDevServer(target.project, target.settings);
      }
      const deleted = await deps.eventStore.deleteDevServer(devServerId);
      if (!deleted) {
        reply.code(404);
        return { error: 'dev server not found' };
      }
      changed();
      return { deleted: true };
    });
  });

  app.post('/dev-servers/:devServerId/runtime', async (request, reply) => {
    const { devServerId } = devServerParams.parse(request.params);
    if (!deps.projectRuntime) {
      reply.code(503);
      return { error: 'project runtime is not configured' };
    }
    const target = await runtimeTarget(devServerId, true);
    if (!target) {
      reply.code(404);
      return { error: 'dev server not found' };
    }
    if (target.project.state !== 'active') {
      reply.code(409);
      return { error: `project ${target.project.id} is not active` };
    }
    if (!target.settings.devServerCommand?.trim()) {
      reply.code(400);
      return { error: 'dev server command is not configured' };
    }
    return withPreviewMutation(devServerId, async () => {
      const runtime = await deps.projectRuntime!.startDevServer(target.project, target.settings);
      await deps.eventStore.updateDevServer(devServerId, { autoStart: true });
      changed();
      return { runtime };
    });
  });

  // Point the server at a session's worktree (preview before merge), or back at
  // the main checkout (`sessionId: null`). A running process is restarted in the
  // new checkout so the switch takes effect immediately; a stopped one just picks
  // the new root on its next start.
  app.post('/dev-servers/:devServerId/preview-session', async (request, reply) => {
    const { devServerId } = devServerParams.parse(request.params);
    const { sessionId } = previewSessionBody.parse(request.body ?? {});
    const current = await deps.eventStore.getDevServer(devServerId);
    if (!current) {
      reply.code(404);
      return { error: 'dev server not found' };
    }
    const project = await deps.eventStore.getProject(current.projectId);
    if (!project || project.hiddenAt !== null) {
      reply.code(404);
      return { error: 'project not found' };
    }
    if (sessionId !== null) {
      if (!deps.projectCloneRoot) {
        reply.code(503);
        return { error: 'session preview is not configured' };
      }
      const session = await deps.eventStore.getSession(sessionId);
      if (!session) {
        reply.code(404);
        return { error: 'session not found' };
      }
      if (session.projectId !== project.id) {
        reply.code(409);
        return { error: 'session belongs to a different project' };
      }
      try {
        containerPathFor(session.worktree, projectClonePath(deps.projectCloneRoot, project));
      } catch {
        reply.code(409);
        return { error: 'session worktree is outside the project checkout' };
      }
    }
    const applySwitch = async () => {
      if (sessionId === null && current.previewSessionId !== null && deps.syncProjectCheckout) {
        await deps.syncProjectCheckout(project.id);
      }
      // Capture run-state BEFORE the switch; status reads pid files only, so the
      // old settings answer it correctly.
      let wasRunning = false;
      if (deps.projectRuntime && project.state === 'active') {
        const before = await runtimeTarget(devServerId);
        if (before) {
          wasRunning = (await deps.projectRuntime.devServerStatus(before.project, before.settings))
            .running;
        }
      }
      const devServer = await deps.eventStore.updateDevServer(devServerId, {
        previewSessionId: sessionId,
      });
      if (!devServer) {
        reply.code(404);
        return { error: 'dev server not found' };
      }
      changed();
      if (wasRunning && deps.projectRuntime) {
        // startDevServer stops any existing process first, so this is the restart.
        const after = await runtimeTarget(devServerId, true);
        if (after && after.settings.devServerCommand?.trim()) {
          try {
            return {
              devServer,
              runtime: await deps.projectRuntime.startDevServer(after.project, after.settings),
            };
          } catch (switchError) {
            // startDevServer stops the old process before starting in the new checkout.
            // Restore both the pointer and the prior running state before surfacing the
            // failed switch, otherwise a preview attempt can silently take the server down.
            await deps.eventStore.updateDevServer(devServerId, {
              previewSessionId: current.previewSessionId,
            });
            changed();
            const restored = await runtimeTarget(devServerId, true);
            if (restored?.settings.devServerCommand?.trim()) {
              try {
                await deps.projectRuntime.startDevServer(restored.project, restored.settings);
              } catch (restoreError) {
                throw new AggregateError(
                  [switchError, restoreError],
                  'dev server preview failed and the previous runtime could not be restored',
                  { cause: restoreError },
                );
              }
            }
            throw switchError;
          }
        }
      }
      return { devServer };
    };
    return sessionId !== current.previewSessionId
      ? withPreviewMutation(devServerId, applySwitch)
      : applySwitch();
  });

  app.get('/dev-servers/:devServerId/runtime', async (request, reply) => {
    const { devServerId } = devServerParams.parse(request.params);
    const resolved = await requireRuntimeTarget(devServerId, reply);
    if ('error' in resolved) return resolved;
    return {
      runtime: await resolved.runtime.devServerStatus(
        resolved.target.project,
        resolved.target.settings,
      ),
    };
  });

  app.post('/dev-servers/:devServerId/runtime/stop', async (request, reply) => {
    const { devServerId } = devServerParams.parse(request.params);
    const resolved = await requireRuntimeTarget(devServerId, reply, false);
    if ('error' in resolved) return resolved;
    return withPreviewMutation(devServerId, async () => {
      const runtime = await resolved.runtime.stopDevServer(
        resolved.target.project,
        resolved.target.settings,
      );
      await deps.eventStore.updateDevServer(devServerId, { autoStart: false });
      changed();
      return { runtime };
    });
  });

  app.get('/dev-servers/:devServerId/runtime/logs', async (request, reply) => {
    const { devServerId } = devServerParams.parse(request.params);
    const resolved = await requireRuntimeTarget(devServerId, reply);
    if ('error' in resolved) return resolved;
    return {
      logs: await resolved.runtime.devServerLogs(resolved.target.project, resolved.target.settings),
    };
  });

  app.get('/dev-servers/:devServerId/runtime/health', async (request, reply) => {
    const { devServerId } = devServerParams.parse(request.params);
    const resolved = await requireRuntimeTarget(devServerId, reply);
    if ('error' in resolved) return resolved;
    return {
      health: await resolved.runtime.devServerHealth(
        resolved.target.project,
        resolved.target.settings,
      ),
    };
  });
}

/** Restore the persisted desired state after a project container is created. */
export async function startAutoDevServers(
  eventStore: EventStore,
  projectRuntime: ProjectRuntime,
  projectCloneRoot: string | undefined,
  projectId: string,
  forcedServerIds?: readonly string[],
): Promise<void> {
  const project = await eventStore.getProject(projectId);
  if (!project || project.state !== 'active') return;
  const projectSettings = await eventStore.getProjectSettings(projectId);
  const servers = await eventStore.listDevServers(projectId);
  const firstDevServer = servers[0];
  const failures: unknown[] = [];
  for (const server of servers) {
    const selected = forcedServerIds ? forcedServerIds.includes(server.id) : server.autoStart;
    if (!selected || !server.command?.trim()) continue;
    let checkoutRoot: string | null = null;
    if (server.previewSessionId && projectCloneRoot) {
      const session = await eventStore.getSession(server.previewSessionId);
      if (session?.projectId === project.id) {
        try {
          checkoutRoot = containerPathFor(
            session.worktree,
            projectClonePath(projectCloneRoot, project),
          );
        } catch {
          checkoutRoot = null;
        }
      }
    }
    try {
      await projectRuntime.startDevServer(project, {
        defaultBranch: projectSettings?.defaultBranch ?? null,
        defaultModel: projectSettings?.defaultModel ?? null,
        devServerId: server.id,
        adoptLegacyDevServerFiles: firstDevServer?.id === server.id,
        devServerCommand: server.command,
        devServerUrl: server.url,
        devServerWorkdir: server.workdir,
        devServerHostPort: server.hostPort,
        devServerContainerPort: server.containerPort,
        devServerCheckoutRoot: checkoutRoot,
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'could not auto-start Dev Servers');
}

/** Capture actual process state before a session preview pointer is changed or deleted. */
export async function runningDevServerIds(
  eventStore: EventStore,
  projectRuntime: ProjectRuntime,
  projectCloneRoot: string | undefined,
  projectId: string,
  candidateIds: readonly string[],
): Promise<string[]> {
  const project = await eventStore.getProject(projectId);
  if (!project || project.state !== 'active') return [];
  const projectSettings = await eventStore.getProjectSettingsRaw(projectId);
  const servers = await eventStore.listDevServers(projectId);
  const firstDevServer = servers[0];
  const running: string[] = [];
  for (const server of servers) {
    if (!candidateIds.includes(server.id)) continue;
    let checkoutRoot: string | null = null;
    if (server.previewSessionId && projectCloneRoot) {
      const session = await eventStore.getSession(server.previewSessionId);
      if (session?.projectId === project.id) {
        try {
          checkoutRoot = containerPathFor(
            session.worktree,
            projectClonePath(projectCloneRoot, project),
          );
        } catch {
          checkoutRoot = null;
        }
      }
    }
    const status = await projectRuntime.devServerStatus(project, {
      defaultBranch: projectSettings?.defaultBranch ?? null,
      defaultModel: projectSettings?.defaultModel ?? null,
      devServerId: server.id,
      adoptLegacyDevServerFiles: firstDevServer?.id === server.id,
      devServerCommand: server.command,
      devServerUrl: server.url,
      devServerWorkdir: server.workdir,
      devServerHostPort: server.hostPort,
      devServerContainerPort: server.containerPort,
      devServerCheckoutRoot: checkoutRoot,
    });
    if (status.running) running.push(server.id);
  }
  return running;
}

function detectionComparableConfig(server: {
  name: string;
  command: string | null;
  workdir: string | null;
  containerPort: string | null;
}) {
  return {
    name: server.name,
    command: server.command,
    workdir: server.workdir,
    containerPort: server.containerPort,
  };
}

function devServerDetectionFingerprint(
  suggestions: Array<{
    key: string;
    name: string;
    command: string;
    workdir: string | null;
    containerPort: string | null;
    status: 'new' | 'changed' | 'configured' | 'missing';
    existingDevServerId: string | null;
    existingConfig: ReturnType<typeof detectionComparableConfig> | null;
  }>,
): string {
  const normalized = suggestions
    .map(({ key, name, command, workdir, containerPort, status, existingConfig }) => ({
      key,
      name,
      command,
      workdir,
      containerPort,
      status,
      existingConfig,
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
