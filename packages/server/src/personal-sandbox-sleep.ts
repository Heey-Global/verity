import type { EventStore } from '@verity/store';

/** How long a person's own sandbox may sit idle before it is put to sleep. */
export const PERSONAL_SANDBOX_IDLE_MS = 30 * 60_000;

export interface PersonalSandboxSleepDeps {
  /** Every person's own sandbox (not a project's original one) that is running. */
  listActive(): Promise<Array<{ projectId: string; userId: string }>>;
  /** Whether anything still needs the sandbox: a running turn, a server, a preview. */
  isBusy(projectId: string, userId: string): Promise<boolean>;
  sleep(projectId: string, userId: string): Promise<void>;
  /** A sandbox that failed to sleep; the sweep goes on with the others. */
  onError?: (error: unknown, projectId: string, userId: string) => void;
  now?: () => number;
  idleMs?: number;
}

/**
 * One sweep over people's own sandboxes (ADR 0023 §4): a sandbox idle for
 * {@link PERSONAL_SANDBOX_IDLE_MS} goes to sleep, so a member's container uses
 * memory only while that member works. `idleSince` carries state between sweeps;
 * a busy sandbox restarts its idle clock, and one that was not seen is forgotten.
 */
export async function sweepPersonalSandboxes(
  deps: PersonalSandboxSleepDeps,
  idleSince: Map<string, number>,
): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const idleMs = deps.idleMs ?? PERSONAL_SANDBOX_IDLE_MS;
  const seen = new Set<string>();
  for (const sandbox of await deps.listActive()) {
    const key = `${sandbox.projectId}\0${sandbox.userId}`;
    seen.add(key);
    if (await deps.isBusy(sandbox.projectId, sandbox.userId)) {
      // Counted again from the first sweep that finds it idle.
      idleSince.delete(key);
      continue;
    }
    const since = idleSince.get(key);
    if (since === undefined) {
      idleSince.set(key, now);
      continue;
    }
    if (now - since < idleMs) continue;
    // One sandbox that fails to sleep must not keep the others awake.
    try {
      await deps.sleep(sandbox.projectId, sandbox.userId);
      idleSince.delete(key);
    } catch (error) {
      deps.onError?.(error, sandbox.projectId, sandbox.userId);
    }
  }
  for (const key of [...idleSince.keys()]) if (!seen.has(key)) idleSince.delete(key);
}

/**
 * Sweep people's own sandboxes every minute and put idle ones to sleep. A sandbox
 * is busy while its person has a running turn in its project or a dev server in it.
 */
export function installPersonalSandboxSleep(
  app: {
    addHook(name: 'onClose', hook: () => void): unknown;
    log: { warn(fields: Record<string, unknown>, message: string): void };
  },
  deps: {
    store: Pick<
      EventStore,
      'projectSandboxes' | 'listRunningTurns' | 'getSession' | 'promptInitiatorAt'
    >;
    hasRunningServersFor: (projectId: string, userId: string) => Promise<boolean | undefined>;
    /** Resolved on every sweep: the provisioner may not exist yet at install time. */
    sleepSandbox: () => ((projectId: string, userId: string) => Promise<void>) | undefined;
  },
): void {
  const { store } = deps;
  const idleSince = new Map<string, number>();
  let running = false;
  const timer = setInterval(() => {
    const sleep = deps.sleepSandbox();
    if (running || sleep === undefined) return;
    running = true;
    void sweepPersonalSandboxes(
      {
        listActive: async () => {
          const active: Array<{ projectId: string; userId: string }> = [];
          for (const sandbox of await store.projectSandboxes.list()) {
            if (sandbox.projectDefault) continue;
            const state = await store.projectSandboxes.state(sandbox.projectId, sandbox.userId);
            if (state?.state === 'active') active.push(sandbox);
          }
          return active;
        },
        isBusy: async (projectId, userId) => {
          if (await deps.hasRunningServersFor(projectId, userId)) return true;
          for (const turn of await store.listRunningTurns()) {
            const session = await store.getSession(turn.sessionId);
            if (session?.projectId !== projectId) continue;
            const initiator = await store.promptInitiatorAt(turn.sessionId, turn.promptSeq);
            if (initiator?.userId === userId) return true;
          }
          return false;
        },
        sleep,
        onError: (error, projectId, userId) =>
          app.log.warn({ err: error, projectId, userId }, 'personal sandbox failed to sleep'),
      },
      idleSince,
    )
      .catch((error: unknown) => {
        app.log.warn({ err: error }, 'personal sandbox sleep sweep failed');
      })
      .finally(() => {
        running = false;
      });
  }, 60_000);
  timer.unref();
  app.addHook('onClose', () => clearInterval(timer));
}
