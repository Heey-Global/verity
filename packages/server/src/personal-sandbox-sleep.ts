/** How long a person's own sandbox may sit idle before it is put to sleep. */
export const PERSONAL_SANDBOX_IDLE_MS = 30 * 60_000;

export interface PersonalSandboxSleepDeps {
  /** Every person's own sandbox (not a project's original one) that is running. */
  listActive(): Promise<Array<{ projectId: string; userId: string }>>;
  /** Whether anything still needs the sandbox: a running turn, a server, a preview. */
  isBusy(projectId: string, userId: string): Promise<boolean>;
  sleep(projectId: string, userId: string): Promise<void>;
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
    await deps.sleep(sandbox.projectId, sandbox.userId);
    idleSince.delete(key);
  }
  for (const key of [...idleSince.keys()]) if (!seen.has(key)) idleSince.delete(key);
}
