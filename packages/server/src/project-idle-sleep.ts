import type { ProjectRecord, PublicPreviewShareRecord } from '@verity/store';

export interface ProjectIdleSleepScheduler {
  runOnce(): Promise<void>;
  stop(): void;
}

export const PROJECT_SANDBOX_IDLE_TIMEOUT_MS = 30 * 60_000;

/**
 * What keeps a project's Sandbox from being replaced or slept. Kept apart
 * rather than folded into one flag, because each has a different remedy: a turn
 * is cancelled, a dev server is stopped, a preview stops being shared. Telling
 * someone to cancel a turn while a preview holds the Sandbox sends them looking
 * for a turn that does not exist.
 */
export type ProjectActivityReason = 'turn' | 'dev_server' | 'preview' | 'unknown';

/** A busy probe's answer: the legacy boolean, or the reasons (busy when any). */
export interface ProjectActivityObservation {
  reason: ProjectActivityReason;
  source: 'sessions' | 'dev_server' | 'local_preview' | 'public_preview' | 'busy_probe';
  sessionId?: string;
  shareId?: string;
}
export interface ProjectActivitySnapshot {
  observations: readonly ProjectActivityObservation[];
}
export type ProjectActivityAnswer =
  boolean | readonly ProjectActivityReason[] | ProjectActivitySnapshot;

/** Compatibility probes cannot name an owner; never infer a turn from `true`. */
export function activityObservations(
  answer: ProjectActivityAnswer,
): readonly ProjectActivityObservation[] {
  if (typeof answer === 'boolean')
    return answer ? [{ reason: 'unknown', source: 'busy_probe' }] : [];
  if ('observations' in answer) return answer.observations;
  return answer.map((reason) => ({ reason, source: 'busy_probe' }));
}
export function activityReasons(answer: ProjectActivityAnswer): ProjectActivityReason[] {
  return [...new Set(activityObservations(answer).map((entry) => entry.reason))];
}

/** A failed source must not erase known activity from the sources that answered. */
export async function observeProjectActivity(input: {
  projectId: string;
  exceptSessionIds?: ReadonlySet<string> | undefined;
  listSessions: () => Promise<readonly { projectId: string | null; sessionId: string }[]>;
  isTurnBusy: (sessionId: string) => boolean;
  hasRunningDevServers: () => boolean;
  hasLocalPreviewShares: () => boolean;
  listShares: () => Promise<readonly PublicPreviewShareRecord[]>;
}): Promise<ProjectActivitySnapshot> {
  const observations: ProjectActivityObservation[] = [];
  try {
    for (const session of await input.listSessions()) {
      if (
        session.projectId === input.projectId &&
        !input.exceptSessionIds?.has(session.sessionId) &&
        input.isTurnBusy(session.sessionId)
      )
        observations.push({ reason: 'turn', source: 'sessions', sessionId: session.sessionId });
    }
  } catch {
    observations.push({ reason: 'unknown', source: 'sessions' });
  }
  try {
    if (input.hasRunningDevServers())
      observations.push({ reason: 'dev_server', source: 'dev_server' });
  } catch {
    observations.push({ reason: 'unknown', source: 'dev_server' });
  }
  try {
    if (input.hasLocalPreviewShares())
      observations.push({ reason: 'preview', source: 'local_preview' });
  } catch {
    observations.push({ reason: 'unknown', source: 'local_preview' });
  }
  try {
    for (const share of await input.listShares()) {
      if (holdsSandbox(share))
        observations.push({
          reason: 'preview',
          source: 'public_preview',
          ...(share.id ? { shareId: share.id } : {}),
        });
    }
  } catch {
    observations.push({ reason: 'unknown', source: 'public_preview' });
  }
  return { observations };
}

/** Managed instances keep the sandbox awake themselves; their offline links do not. */
function holdsSandbox(share: PublicPreviewShareRecord): boolean {
  return !share.managedInstanceId && ['creating', 'active', 'revoking'].includes(share.state);
}

/** The non-turn reasons a Sandbox is in use, in the order they are reported. */
export async function persistentSandboxActivityReasons(input: {
  listShares: () => Promise<readonly PublicPreviewShareRecord[]>;
  hasLocalPreviewShares?: () => boolean;
  hasRunningDevServers?: () => boolean;
}): Promise<ProjectActivityReason[]> {
  const reasons: ProjectActivityReason[] = [];
  if (input.hasRunningDevServers?.()) reasons.push('dev_server');
  if (input.hasLocalPreviewShares?.() || (await input.listShares()).some(holdsSandbox))
    reasons.push('preview');
  return reasons;
}

/** Why a manual recreate is refused, naming what would end it. A turn comes
 *  first: it is the one a recreate would kill outright. */
export function recreateRefusalMessage(
  projectId: string,
  reasons: readonly ProjectActivityReason[],
): string {
  if (reasons.includes('turn'))
    return `project ${projectId} has a turn in flight — cancel it or wait, then recreate`;
  if (reasons.includes('dev_server'))
    return `project ${projectId} has a running dev server — stop it, then recreate`;
  if (reasons.includes('preview'))
    return `project ${projectId} is shared as a preview — stop sharing it, then recreate`;
  return `project ${projectId} activity could not be confirmed idle — wait for verification, then recreate`;
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
