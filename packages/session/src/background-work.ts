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

/**
 * Task id of the transcript marker a backend writes while it holds a turn for
 * background work. It is the durable statement that the turn is held — the
 * Conductor reads it rather than the agent's own task edges, which a backend
 * that never holds also emits and whose ends can be lost.
 */
export const BACKGROUND_HOLD_TASK_ID = 'verity-background-hold';

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
  private sawWork = false;
  // Whether the runtime has sent a complete background-task level this turn.
  // Edges alone never hold a turn: an `ended` edge can be lost, and without a
  // level to correct it the turn would sit out the whole hold limit. Without
  // levels the turn ends at its prompt response, exactly as before.
  private levelSeen = false;
  private lastActivity = Date.now();
  private notify: (() => void) | undefined;
  private wakeExplicit: (() => void) | undefined;
  // A wake that arrived while no wait was registered — for example between a
  // wait resolving and the caller's next one. Kept until a wait consumes it.
  private wakePending = false;

  /** Record the lifecycle facts carried by one session update's `_meta`. */
  observe(meta: { [key: string]: unknown } | null | undefined): void {
    for (const signal of lifecycleSignalsFromMeta(meta)) this.signal(signal);
    this.touch();
  }

  signal(signal: StructuredLifecycleSignal): void {
    // Bare edges do not count, for the same reason they do not hold a turn:
    // without levels the turn ends at its prompt response, exactly as before.
    if (
      signal.type === 'background' ||
      signal.type === 'cycle' ||
      (signal.type === 'task' && this.levelSeen)
    ) {
      this.sawWork = true;
    }
    switch (signal.type) {
      case 'task':
        if (signal.phase === 'started') this.tasks.add(signal.id);
        else if (signal.phase === 'ended') this.tasks.delete(signal.id);
        break;
      case 'background':
        this.levelSeen = true;
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

  /** Whether the agent reported any background work or self-started cycle at
   * all. A task that ends during the prompt can still provoke a cycle that only
   * starts after the prompt answers. */
  get observedWork(): boolean {
    return this.sawWork;
  }

  get busy(): boolean {
    return this.cycle || this.prompts > 0 || (this.levelSeen && this.tasks.size > 0);
  }

  /** Wake a pending {@link waitUntilQuiet} so its caller re-checks its own state. */
  wake(): void {
    this.wakePending = true;
    this.changed(true);
  }

  /**
   * Resolve once the agent has been idle for `quietMs`, at `deadline` (epoch ms),
   * or as soon as {@link wake} is called.
   */
  async waitUntilQuiet(quietMs: number, deadline: number): Promise<BackgroundHoldOutcome> {
    for (;;) {
      if (this.wakePending) {
        this.wakePending = false;
        return 'woken';
      }
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
          this.wakeExplicit = undefined;
          resolve(explicit);
        };
        this.notify = () => finish(false);
        this.wakeExplicit = () => finish(true);
      });
      if (woken) {
        this.wakePending = false;
        return 'woken';
      }
    }
  }

  private changed(explicit = false): void {
    if (explicit) this.wakeExplicit?.();
    else this.notify?.();
  }
}
