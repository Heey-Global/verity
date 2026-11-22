import type { ServerDeps } from './server-deps.js';
import type { createRunnerArtifactPurge } from './runner-artifact-purge.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { EventStore } from '@verity/store';
import type { EmbeddedServerConfig } from './embedded-types.js';
import { candidateRunnerProjectIds, CONTROL_PLANE_RUNNER_PROJECT_ID } from './embedded-support.js';
import { sandboxPersonTag } from './sandbox-identity.js';
import {
  pendingSessionCleanups,
  createSessionCleanupProcessor,
  createSessionCleanupWorker,
  deleteRunnerSessionHome,
} from './pending-session-cleanup.js';
import { purgeSessionArtifacts as purgeSessionArtifactFiles } from './session-artifacts.js';

export function createEmbeddedSessionCleanup(ctx: {
  dataVolumeRoot: string | undefined;
  config: Pick<EmbeddedServerConfig, 'controlPlaneRunner' | 'sessionHomeDeleteTimeoutMs'>;
  eventStore: EventStore;
  log: () => FastifyInstance['log'];
}) {
  const { dataVolumeRoot, config, eventStore, log } = ctx;
  const cleanupAbort = new AbortController();
  const cleanupProcessor =
    dataVolumeRoot === undefined
      ? undefined
      : createSessionCleanupProcessor({
          root: join(dataVolumeRoot, 'pending-session-cleanup'),
          sessionExists: async (sessionId) =>
            (await eventStore.getSession(sessionId)) !== undefined,
          refreshBindings: async (sessionId) => {
            const deletion = await eventStore.getSessionDeletion(sessionId);
            return deletion
              ? ((
                  JSON.parse(deletion.payload) as {
                    artifactBindings?: { backend: string; backendSessionId: string }[];
                  }
                ).artifactBindings ?? [])
              : [];
          },
          runtimeState: async (projectId) => {
            const runtimeExists = existsSync(join(dataVolumeRoot, 'runners', projectId));
            if (projectId === CONTROL_PLANE_RUNNER_PROJECT_ID && config.controlPlaneRunner)
              return runtimeExists ? 'ready' : 'unavailable';
            // A person's own runtime (`u<tag>/<project>`) follows their sandbox.
            const [tag, ownProjectId] = projectId.split('/');
            if (ownProjectId !== undefined && tag !== undefined) {
              const sandbox = (await eventStore.projectSandboxes.list(ownProjectId)).find(
                (candidate) => sandboxPersonTag(candidate.userId) === tag,
              );
              const state =
                sandbox === undefined
                  ? undefined
                  : (await eventStore.projectSandboxes.state(ownProjectId, sandbox.userId))?.state;
              if (!runtimeExists) return state === undefined ? 'absent' : 'unavailable';
              if (state === 'active') return 'ready';
              if (state?.startsWith('sleeping')) return 'sleeping';
              return state === undefined ? 'absent' : 'unavailable';
            }
            const project = await eventStore.getProject(projectId);
            if (!runtimeExists)
              return project === undefined
                ? 'absent'
                : project.state === 'sleeping'
                  ? 'sleeping'
                  : 'unavailable';
            if (project?.state === 'active') return 'ready';
            if (project?.state === 'sleeping') return 'sleeping';
            return 'unavailable';
          },
          deleteHome: (projectId, pending) =>
            deleteRunnerSessionHome(
              join(dataVolumeRoot, 'runners', projectId, 'supervisor.sock'),
              pending.sessionId,
              config.sessionHomeDeleteTimeoutMs,
            ),
          purgeArtifacts: async (projectId, pending) => {
            const result = await purgeSessionArtifactFiles({
              runtimeDir: join(dataVolumeRoot, 'runners', projectId),
              sandboxCwd: pending.sandboxCwd,
              sessionId: pending.sessionId,
              bindings: pending.bindings,
              scope: 'session-delete',
            });
            if (result.outsideRuntime.length > 0 || result.unknownBackends.length > 0)
              return 'unsafe';
            return result.failed.length === 0 && !result.unresolved ? 'clean' : 'retry';
          },
          report: (projectId, pending, reason, error) =>
            log().warn(
              { err: error, sessionId: pending.sessionId, projectId, reason },
              reason === 'unsafe'
                ? 'verity: session artifact cleanup requires attention'
                : 'verity: runner session cleanup deferred with backoff',
            ),
          stopped: () => cleanupAbort.signal.aborted,
        });
  const runPendingCleanup =
    cleanupProcessor === undefined
      ? undefined
      : (projectId: string) => cleanupProcessor.run(projectId);
  const sessionCleanupWorker =
    cleanupProcessor === undefined
      ? undefined
      : createSessionCleanupWorker(
          () => cleanupProcessor.run(),
          (error) => log().warn({ err: error }, 'verity: pending cleanup scan failed'),
        );
  return { cleanupAbort, cleanupProcessor, runPendingCleanup, sessionCleanupWorker };
}

export function createEmbeddedSessionCleanupBindings(ctx: {
  dataVolumeRoot: string | undefined;
  config: Pick<EmbeddedServerConfig, 'runnerSupervisor' | 'controlPlaneRunner'>;
  eventStore: Pick<EventStore, 'getSessionDeletion' | 'getProject' | 'getSessionBackendStates'>;
  purgeRunnerArtifacts: ReturnType<typeof createRunnerArtifactPurge> | undefined;
  sessionSandboxCwd: (worktree: string) => string;
  cleanupProcessor: ReturnType<typeof createEmbeddedSessionCleanup>['cleanupProcessor'];
  sessionCleanupWorker: ReturnType<typeof createEmbeddedSessionCleanup>['sessionCleanupWorker'];
}): Pick<
  ServerDeps,
  'scheduleSessionCleanup' | 'cleanupDeletedSessionRuntime' | 'queueSessionArtifacts'
> {
  const {
    dataVolumeRoot,
    config,
    eventStore,
    purgeRunnerArtifacts,
    sessionSandboxCwd,
    cleanupProcessor,
    sessionCleanupWorker,
  } = ctx;
  return purgeRunnerArtifacts === undefined
    ? {}
    : {
        scheduleSessionCleanup: () => sessionCleanupWorker?.run(),
        cleanupDeletedSessionRuntime: async (sessionId: string, projectId: string | null) => {
          if (
            config.runnerSupervisor !== true ||
            (projectId === null && !config.controlPlaneRunner)
          )
            return 'not-applicable' as const;
          const cleanupRoot = join(dataVolumeRoot!, 'pending-session-cleanup');
          const before = (await pendingSessionCleanups(cleanupRoot)).find(
            (record) => record.sessionId === sessionId,
          );
          const deletion = await eventStore.getSessionDeletion(sessionId);
          const retained = deletion
            ? (JSON.parse(deletion.payload) as {
                session?: { worktree?: string };
                artifactBindings?: { backend: string; backendSessionId: string }[];
              })
            : undefined;
          const captured =
            retained?.session?.worktree === undefined
              ? undefined
              : {
                  sessionId,
                  sandboxCwd: sessionSandboxCwd(retained.session.worktree),
                  runnerProjectIds:
                    before?.runnerProjectIds ??
                    candidateRunnerProjectIds({
                      projectId,
                      isControlPlaneProject:
                        projectId !== null &&
                        (await eventStore.getProject(projectId))?.kind === 'control_plane',
                      controlPlaneRunner: config.controlPlaneRunner === true,
                    }),
                  bindings: retained.artifactBindings ?? [],
                };
          await cleanupProcessor?.runSession(sessionId, captured);
          const pending = await pendingSessionCleanups(cleanupRoot);
          if (pending.some((record) => record.sessionId === sessionId)) return 'deferred' as const;
          if (
            projectId !== null &&
            (await eventStore.getProject(projectId)) === undefined &&
            !(before?.runnerProjectIds ?? [projectId]).some((id) =>
              existsSync(join(dataVolumeRoot!, 'runners', id)),
            )
          )
            return 'absent' as const;
          return 'clean' as const;
        },
        queueSessionArtifacts: async (sessionId: string): Promise<void> => {
          // Read the bindings HERE rather than in the helper: this is the delete path,
          // and the rows are about to go with the FK cascade.
          await purgeRunnerArtifacts(
            sessionId,
            await eventStore.getSessionBackendStates(sessionId),
            'session-delete',
          );
        },
      };
}
