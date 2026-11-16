import type { ProjectActivityReason } from './project-idle-sleep.js';

/** A fixed quiet window avoids another setting; use the server's local clock. */
function inSandboxUpdateWindow(now: number): boolean {
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
  private restoring: Promise<void> | undefined;
  async restore(store: StateStore | undefined): Promise<void> {
    if (this.restored) return;
    this.restoring ??= (async () => {
      if (store)
        for (const [id, saved] of await store.list()) {
          const state: SandboxUpdateState =
            saved.recovery?.state === 'checking'
              ? {
                  ...saved,
                  recovery: {
                    state: 'failed',
                    at: Date.now(),
                    detail:
                      'Recovery check interrupted by server restart; verify dev servers and previews',
                  },
                }
              : saved;
          if (state !== saved) await store.set(id, state);
          this.states.set(id, state);
        }
      this.restored = true;
    })().catch((error: unknown) => {
      this.restoring = undefined;
      throw error;
    });
    return this.restoring;
  }
  async defer(
    store: StateStore | undefined,
    id: string,
    reasons: readonly ProjectActivityReason[],
    now: number,
  ): Promise<boolean> {
    await this.restore(store);
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
    await this.restore(store);
    const state: SandboxUpdateState = {
      since: recovery.at,
      reasons: [],
      reportedAt: recovery.at,
      recovery,
    };
    await store?.set(id, state);
    this.states.set(id, state);
  }
  async beginRecovery(store: StateStore | undefined, id: string): Promise<void> {
    await this.recovered(store, id, {
      state: 'checking',
      at: Date.now(),
      detail: 'Update started; checking service recovery after replacement',
    });
  }
  /** Journal before interruption, then recheck after the durable write. */
  async authorizeRecovery<T>(
    store: StateStore | undefined,
    id: string,
    authorize: () => Promise<T>,
  ): Promise<T> {
    await this.restore(store);
    const previous = this.states.get(id);
    await authorize();
    await this.beginRecovery(store, id);
    const checking = this.states.get(id);
    try {
      return await authorize();
    } catch (cause) {
      // A refusal before retirement must preserve the original waiting clock.
      if (this.states.get(id) === checking) {
        if (previous) {
          await store?.set(id, previous);
          this.states.set(id, previous);
        } else {
          await store?.clear(id);
          this.states.delete(id);
        }
      }
      throw cause;
    }
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
  async failRecovery(store: StateStore | undefined, id: string, cause: unknown): Promise<void> {
    await this.restore(store);
    const saved = this.states.get(id);
    if (saved?.recovery?.state !== 'checking') return;
    const state: SandboxUpdateState = {
      ...saved,
      recovery: {
        state: 'failed',
        at: Date.now(),
        detail: `Update interrupted before recovery completed: ${String(cause).slice(0, 500)}`,
      },
    };
    this.states.set(id, state);
    await store?.set(id, state).catch(() => undefined);
  }
  async clearWait(store: StateStore | undefined, id: string): Promise<void> {
    await this.restore(store);
    if (!this.states.has(id) || this.states.get(id)?.recovery) return;
    await store?.clear(id);
    this.states.delete(id);
  }
}
