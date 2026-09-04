import type { StandbyDirectiveClient } from './server-update-controller.js';
import type { StandbyDirective } from './standby-directive.js';
import type { StandbyLifecycle } from './standby-lifecycle.js';

/**
 * The managed Server's side of the standby directive (ADR 0008 D9).
 *
 * Polls the Updater for the state it should be in and moves its own lifecycle
 * there, then reports what it reached. Polling rather than being told, because
 * the Updater runs with `network_mode: none` and cannot call in — the same
 * reason the key handoff is a mailbox rather than a request.
 *
 * The result is that a cutover no longer has to stop the outgoing container to
 * take the control plane away from it. The old process gives up the generation,
 * the pools, and the listeners; keeps the memory and the unlocked key; and is
 * still there to serve again if the new generation does not work out.
 */

type StandbyFollowerStep =
  /** No operation is under way, or the directive is not about this Server. */
  | 'idle'
  /** The directive matches what this Server already is. */
  | 'unchanged'
  /** Gave up the control plane without dying. */
  | 'quiesced'
  /** Took a newer generation and started serving again. */
  | 'resumed'
  /**
   * The transition did not happen. Never fatal here: the Updater's wait is
   * bounded and falls back to stopping the container, which is what a cutover
   * did before any of this existed.
   */
  | 'failed';

export interface StandbyFollowerDeps {
  readonly client: StandbyDirectiveClient;
  readonly lifecycle: StandbyLifecycle;
  /**
   * The operation that activated THIS Server (`VERITY_UPDATE_ID`), if any.
   *
   * A directive names the operation promoting a candidate, so a Server that
   * finds its own id there is the incoming generation reading a directive
   * written about its predecessor. Without this check a promoted candidate
   * would quiesce itself the instant it started serving.
   */
  readonly operationId?: string | undefined;
  readonly onError?: (error: unknown) => void;
}

export interface StandbyFollower {
  /** Follow the directive by at most one transition. Throws only on transport. */
  step(): Promise<StandbyFollowerStep>;
  stop(): void;
}

export function createStandbyFollower(deps: StandbyFollowerDeps): StandbyFollower {
  let stopped = false;
  return {
    async step() {
      if (stopped) return 'idle';
      const standby = await deps.client.read();
      if (stopped) return 'idle';
      // A directive about this Server's own promotion says nothing about this
      // Server, and neither does the absence of an operation.
      if (standby === null || standby.operationId === deps.operationId) return 'idle';
      const directive: StandbyDirective = standby.directive;
      const state = deps.lifecycle.state;
      // `failed` and `stopped` are not states a directive can argue with: the
      // first has unknown authority and must exit, the second is already gone.
      if (state !== 'serving' && state !== 'quiesced') return 'idle';

      let reached: StandbyDirective = state;
      let step: StandbyFollowerStep = 'unchanged';
      if (directive !== state) {
        try {
          if (directive === 'quiesced') await deps.lifecycle.quiesce();
          else await deps.lifecycle.resume();
          reached = directive;
          step = directive === 'quiesced' ? 'quiesced' : 'resumed';
        } catch (error) {
          // Reported, not thrown: a resume usually fails because the successor
          // still holds the process lock, which is a retry rather than a fault.
          deps.onError?.(error);
          // A transition can fail after partially closing or binding listeners.
          // Do not describe that unknown state as safely serving/quiesced; lack
          // of acknowledgement makes the cutover retry or fall back.
          return 'failed';
        }
      }
      // Acknowledged even when nothing moved, and even after a failure: the
      // cutover waits for a description of this process, not for a success. A
      // refusal means the operation moved on while this step ran, which the
      // next read reflects anyway.
      if (!stopped) await deps.client.acknowledge(standby.operationId, reached);
      return step;
    },

    stop() {
      stopped = true;
    },
  };
}

export interface StandbyFollowerLoopDeps extends StandbyFollowerDeps {
  /** How often to look for a directive while no operation is under way. */
  readonly idleIntervalMs?: number;
  /** How often to look while one is, or while a transition needs retrying. */
  readonly activeIntervalMs?: number;
  readonly onStep?: (step: StandbyFollowerStep) => void;
}

export interface StandbyFollowerLoop {
  stop(): void;
}

const DEFAULT_IDLE_INTERVAL_MS = 2_000;
const DEFAULT_ACTIVE_INTERVAL_MS = 250;

export function startStandbyFollower(deps: StandbyFollowerLoopDeps): StandbyFollowerLoop {
  const follower = createStandbyFollower(deps);
  const idle = deps.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS;
  const active = deps.activeIntervalMs ?? DEFAULT_ACTIVE_INTERVAL_MS;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    let outcome: StandbyFollowerStep = 'idle';
    try {
      outcome = await follower.step();
      deps.onStep?.(outcome);
    } catch (error) {
      deps.onError?.(error);
    }
    if (stopped) return;
    timer = setTimeout(() => void tick(), outcome === 'idle' ? idle : active);
    // A quiesced Server has closed every listener it had, so this timer is the
    // only thing left holding the event loop open — and it has to, or the
    // standby would exit the moment it stopped serving and there would be
    // nothing alive to roll back to. While it is serving, the listeners keep the
    // process up and this loop must not be a reason to stay.
    if (deps.lifecycle.state === 'quiesced') timer.ref();
    else timer.unref();
  };
  void tick();

  return {
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      follower.stop();
    },
  };
}
