import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { EventStore } from '@verity/store';
import type { EmbeddedServerConfig } from './embedded-types.js';
import { CONTROL_PLANE_RUNNER_PROJECT_ID } from './embedded-support.js';
import { sandboxPersonTag } from './sandbox-identity.js';
import {
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
