import type { Conductor } from '@verity/session';
import type { FastifyInstance } from 'fastify';

import type { LiveHub } from './live/live-hub.js';
import type { ResourceObserver } from './live/resource-observer.js';
import type { PushSender } from './push-sender.js';
import type { ServerDeps } from './server-deps.js';
import type { SessionArtifactPurgeBudget } from './server-types.js';

/**
 * Start and stop work that lives as long as the server.
 *
 * `onClose` registers a Fastify `onClose` hook at the call site. Fastify runs
 * those hooks last-registered first, so a component that is set up after
 * another is also stopped before it, exactly as with `app.addHook`.
 *
 * Intervals are cleared together in one `preClose` hook, which runs before any
 * `onClose` hook wherever that was registered. No tick can therefore reach a
 * service that is already shutting down.
 */
export interface ServerLifecycle {
  onClose(stop: () => unknown): void;
  /**
   * Run `tick` every `intervalMs` until the server closes. The timer never
   * keeps the process alive. With `startWhenReady`, the first interval begins
   * once the server is ready, so no tick runs against a half-built server.
   */
  every(intervalMs: number, tick: () => void, options?: { startWhenReady?: boolean }): void;
}

export function createServerLifecycle(app: FastifyInstance): ServerLifecycle {
  const intervals = new Set<ReturnType<typeof setInterval>>();
  let closing = false;
  app.addHook('preClose', (done) => {
    closing = true;
    for (const interval of intervals) clearInterval(interval);
    intervals.clear();
    done();
  });
  const start = (intervalMs: number, tick: () => void) => {
    if (closing) return;
    const interval = setInterval(tick, intervalMs);
    interval.unref();
    intervals.add(interval);
  };
  return {
    onClose(stop) {
      app.addHook('onClose', async () => {
        await stop();
      });
    },
    every(intervalMs, tick, options) {
      if (options?.startWhenReady) app.addHook('onReady', () => start(intervalMs, tick));
      else start(intervalMs, tick);
    },
  };
}

/**
 * What `buildServer` shares with the domain modules it installs. A module takes
 * this context through its `install<Area>(app, ctx)` entry point instead of
 * importing the composition root (docs/adr/0029-module-boundaries-and-file-size.md).
 *
 * Only state used by more than one area belongs here. State that a single area
 * owns stays private to that area's module.
 */
export interface ServerContext {
  readonly app: FastifyInstance;
  readonly deps: ServerDeps;
  readonly lifecycle: ServerLifecycle;
  readonly conductor: Conductor;
  readonly liveHub: LiveHub;
  readonly resources: ResourceObserver;
  readonly pushSender: PushSender | undefined;
  /**
   * Projects whose `DELETE /projects/:id` teardown is running, and the sessions
   * it is reaping. Nothing may start work on either until the teardown ends.
   */
  readonly projectsBeingDeleted: ReadonlySet<string>;
  readonly sessionsBeingReaped: ReadonlySet<string>;
  /**
   * Delete a session with its artifacts. Deletes within one project are
   * serialized by this one instance, so modules use it rather than building
   * their own with `createSessionDeletion`.
   */
  readonly deleteSession: (
    sessionId: string,
    budget?: SessionArtifactPurgeBudget,
  ) => Promise<boolean>;
}
