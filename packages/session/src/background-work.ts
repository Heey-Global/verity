import {
  lifecycleSignalsFromMeta,
  type StructuredLifecycleSignal,
} from './structured-lifecycle.js';

/**
 * Longest time a turn is held open for background work after the agent's own
 * prompt has answered. Background shells, monitors and subagents run inside the
 * agent process, so ending the turn ends them; this bound keeps a forgotten
 * watcher from holding a session (and its Sandbox) busy indefinitely.
 */
export const BACKGROUND_HOLD_MAX_MS = 2 * 60 * 60_000;

/**
 * How long a held turn must stay quiet — no live task, no self-started cycle, no
 * pending prompt and no agent output — before it settles. A task's end and the
 * cycle the agent starts to react to it are separate messages, so settling on
 * the first idle instant would cut that reaction off.
 */
export const BACKGROUND_QUIET_MS = 3_000;

export type BackgroundHoldOutcome = 'quiet' | 'deadline' | 'woken';

/**
 * What the agent is still doing after its prompt answered: background tasks it
 * launched, a model cycle it started on its own, and prompts sent into the held
 * turn. Fed from the vendor-neutral lifecycle metadata (see
 * `structured-lifecycle.ts`); a backend without those signals never looks busy,
 * so its turns end exactly as before.
 */
export class BackgroundWork {
  private readonly tasks = new Set<string>();
  private cycle = false;
  private prompts = 0;
  private lastActivity = Date.now();
  private notify: (() => void) | undefined;
  private wakeExplicit: (() => void) | undefined;

  /** Record the lifecycle facts carried by one session update's `_meta`. */
  observe(meta: { [key: string]: unknown } | null | undefined): void {
    for (const signal of lifecycleSignalsFromMeta(meta)) this.signal(signal);
    this.touch();
  }

  signal(signal: StructuredLifecycleSignal): void {
    switch (signal.type) {
      case 'task':
        if (signal.phase === 'started') this.tasks.add(signal.id);
        else if (signal.phase === 'ended') this.tasks.delete(signal.id);
        break;
      case 'background':
        // A level replaces the edges: a task whose end was lost is dropped, and
        // one whose start has not arrived yet is already counted.
        this.tasks.clear();
        for (const id of signal.live) this.tasks.add(id);
        break;
      case 'cycle':
        this.cycle = signal.phase === 'started';
        break;
      default:
        return;
    }
    this.changed();
  }

  /** Any agent output: a reaction may follow, so the quiet window restarts. */
  touch(): void {
    this.lastActivity = Date.now();
    this.changed();
  }

  /** A prompt sent into the held turn is outstanding until its response. */
  beginPrompt(): void {
    this.prompts += 1;
    this.touch();
  }

  endPrompt(): void {
    this.prompts = Math.max(0, this.prompts - 1);
    this.touch();
  }

  get busy(): boolean {
    return this.cycle || this.tasks.size > 0 || this.prompts > 0;
  }

  get liveTasks(): number {
    return this.tasks.size;
  }

  /** Wake a pending {@link waitUntilQuiet} so its caller re-checks its own state. */
  wake(): void {
    this.changed(true);
  }

  /**
   * Resolve once the agent has been idle for `quietMs`, at `deadline` (epoch ms),
   * or as soon as {@link wake} is called.
   */
  async waitUntilQuiet(quietMs: number, deadline: number): Promise<BackgroundHoldOutcome> {
    for (;;) {
      const now = Date.now();
      if (now >= deadline) return 'deadline';
      const quietLeft = this.lastActivity + quietMs - now;
      if (!this.busy && quietLeft <= 0) return 'quiet';
      const wait = this.busy ? deadline - now : Math.min(quietLeft, deadline - now);
      const woken = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => finish(false), wait);
        const finish = (explicit: boolean): void => {
          clearTimeout(timer);
          this.notify = undefined;
          resolve(explicit);
        };
        this.notify = () => finish(false);
        this.wakeExplicit = () => finish(true);
      });
      this.wakeExplicit = undefined;
      if (woken) return 'woken';
    }
  }

  private changed(explicit = false): void {
    if (explicit) this.wakeExplicit?.();
    else this.notify?.();
  }
}
