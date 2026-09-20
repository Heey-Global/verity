import type { DevServerRecord, ProjectRecord, PublicPreviewShareRecord } from '@verity/store';

import type { ProjectRuntime } from './project-runtime.js';

export interface ProjectIdleSleepScheduler {
  runOnce(): Promise<void>;
  stop(): void;
}

export const PROJECT_SANDBOX_IDLE_TIMEOUT_MS = 30 * 60_000;

export async function projectHasPersistentSandboxActivity(input: {
  project: ProjectRecord;
  listShares: () => Promise<readonly PublicPreviewShareRecord[]>;
  listDevServers: () => Promise<readonly DevServerRecord[]>;
  runtime?: ProjectRuntime | undefined;
}): Promise<boolean> {
  const shares = await input.listShares();
  if (shares.some((share) => ['creating', 'active', 'revoking'].includes(share.state))) return true;
  if (input.runtime === undefined || input.project.state !== 'active') return false;

  const servers = await input.listDevServers();
  for (const [index, server] of servers.entries()) {
    try {
      const status = await input.runtime.devServerStatus(input.project, {
        defaultBranch: null,
        defaultModel: null,
        devServerId: server.id,
        adoptLegacyDevServerFiles: index === 0,
        devServerCommand: server.command,
        devServerUrl: server.url,
        devServerWorkdir: server.workdir,
        devServerHostPort: server.hostPort,
        devServerContainerPort: server.containerPort,
      });
      if (status.running) return true;
    } catch {
      // Unknown runtime state is not permission to stop the Sandbox.
      return true;
    }
  }
  return false;
}

export function startProjectIdleSleepScheduler(input: {
  listProjects: () => Promise<readonly ProjectRecord[]>;
  isBusy: (projectId: string) => Promise<boolean>;
  lastActivityAt?: (projectId: string) => number | undefined;
  sleepProject: (projectId: string) => Promise<unknown>;
  idleMs: number;
  intervalMs?: number;
  now?: () => number;
  onSlept?: (projectId: string) => void;
  onError?: (projectId: string | undefined, error: unknown) => void;
  onSweep?: (projects: readonly ProjectRecord[]) => void;
  startTimer?: boolean;
}): ProjectIdleSleepScheduler {
  const now = input.now ?? Date.now;
  const idleSince = new Map<string, number>();
  let running = false;
  let stopped = false;

  const runOnce = async (): Promise<void> => {
    if (running || stopped || input.idleMs <= 0) return;
    running = true;
    try {
      const projects = await input.listProjects();
      input.onSweep?.(projects);
      const activeIds = new Set(
        projects
          .filter((project) => project.kind !== 'control_plane' && project.state === 'active')
          .map((project) => project.id),
      );
      for (const projectId of idleSince.keys()) {
        if (!activeIds.has(projectId)) idleSince.delete(projectId);
      }
      for (const projectId of activeIds) {
        try {
          const recordedActivity = input.lastActivityAt?.(projectId);
          const observedSince = idleSince.get(projectId);
          if (recordedActivity !== undefined && observedSince !== undefined) {
            idleSince.set(projectId, Math.max(observedSince, recordedActivity));
          }
          if (await input.isBusy(projectId)) {
            idleSince.set(projectId, now());
            continue;
          }
          const since = idleSince.get(projectId);
          if (since === undefined) {
            idleSince.set(projectId, now());
            continue;
          }
          if (now() - since < input.idleMs) continue;
          // Close the observation-to-mutation gap as much as possible. The
          // provisioner's exclusive mutation barrier is the final race fence.
          if (await input.isBusy(projectId)) {
            idleSince.set(projectId, now());
            continue;
          }
          const latestActivity = input.lastActivityAt?.(projectId);
          if (latestActivity !== undefined && latestActivity > since) {
            idleSince.set(projectId, latestActivity);
            continue;
          }
          await input.sleepProject(projectId);
          idleSince.delete(projectId);
          input.onSlept?.(projectId);
        } catch (error) {
          idleSince.set(projectId, now());
          input.onError?.(projectId, error);
        }
      }
    } catch (error) {
      input.onError?.(undefined, error);
    } finally {
      running = false;
    }
  };

  const timer =
    input.startTimer === false || input.idleMs <= 0
      ? undefined
      : setInterval(() => void runOnce(), input.intervalMs ?? 60_000);
  timer?.unref();
  return {
    runOnce,
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
    },
  };
}
