import type { ProjectActivityReason } from './project-idle-sleep.js';

/** A fixed quiet window avoids another setting; use the server's local clock. */
export function inSandboxUpdateWindow(now: number): boolean {
  const hour = new Date(now).getHours();
  return hour >= 3 && hour < 5;
}
/** Both unknown activity and turns always fence automatic replacement. */
export function canInterruptSandboxServices(reasons: readonly ProjectActivityReason[]): boolean {
  return (
    reasons.length > 0 && reasons.every((reason) => reason === 'dev_server' || reason === 'preview')
  );
}
export function nightlySandboxUpdate(
  now: number,
  reasons: readonly ProjectActivityReason[],
): boolean {
  return inSandboxUpdateWindow(now) && canInterruptSandboxServices(reasons);
}

export interface SandboxUpdateState {
  since: number;
  reasons: string[];
  reportedAt: number;
  recovery?: { state: 'checking' | 'ready' | 'failed'; at: number; detail: string };
}
interface StateStore {
  list(): Promise<Map<string, SandboxUpdateState>>;
  set(projectId: string, state: SandboxUpdateState): Promise<void>;
  clear(projectId: string): Promise<void>;
}
/** Keeps waiting reports stable across restarts without making them repair mandates. */
export class SandboxUpdateTracker {
  readonly states = new Map<string, SandboxUpdateState>();
  private restored = false;
  async restore(store: StateStore | undefined): Promise<void> {
    if (this.restored) return;
    if (store) for (const [id, state] of await store.list()) this.states.set(id, state);
    this.restored = true;
  }
  async defer(
    store: StateStore | undefined,
    id: string,
    reasons: readonly ProjectActivityReason[],
    now: number,
  ): Promise<boolean> {
    const saved = this.states.get(id);
    const previous = saved?.reasons.length ? saved : undefined;
    const ordered = [...new Set(reasons)].sort();
    const report =
      !previous ||
      ordered.join(',') !== previous.reasons.join(',') ||
      now - previous.reportedAt >= 30 * 60_000;
    const state: SandboxUpdateState = {
      since: previous?.since ?? now,
      reasons: ordered,
      reportedAt: report ? now : previous.reportedAt,
    };
    if (report) await store?.set(id, state);
    this.states.set(id, state);
    return report;
  }
  async recovered(
    store: StateStore | undefined,
    id: string,
    recovery: NonNullable<SandboxUpdateState['recovery']>,
  ): Promise<void> {
    const state: SandboxUpdateState = {
      since: recovery.at,
      reasons: [],
      reportedAt: recovery.at,
      recovery,
    };
    await store?.set(id, state);
    this.states.set(id, state);
  }
  async checkRecovery(
    store: StateStore | undefined,
    id: string,
    check: () => Promise<{ state: 'ready' | 'failed'; detail: string }>,
    now: () => number,
    notify?: (id: string, result: { state: 'ready' | 'failed'; detail: string }) => void,
  ): Promise<void> {
    await this.recovered(store, id, {
      state: 'checking',
      at: now(),
      detail: 'Checking dev servers and previews after update',
    });
    const result = await check().catch((error: unknown) => ({
      state: 'failed' as const,
      detail: String(error),
    }));
    await this.recovered(store, id, { ...result, at: now() });
    try {
      notify?.(id, result);
    } catch {
      /* Telemetry never owns the lifecycle. */
    }
  }
  async clearWait(store: StateStore | undefined, id: string): Promise<void> {
    if (!this.states.has(id) || this.states.get(id)?.recovery) return;
    await store?.clear(id);
    this.states.delete(id);
  }
}
