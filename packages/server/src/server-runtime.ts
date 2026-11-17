import type { AgentEvent } from '@verity/events';
import type { FastifyInstance } from 'fastify';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerDeps } from './server-deps.js';
import { emitSessionEvent } from './session-event-writer.js';
import { createScratchProvisioner } from './worktree.js';

export function startServerMessageProjection(deps: ServerDeps): void {
  // Resume the bounded search backfill independently of requests.
  if (typeof deps.eventStore.scheduleMessageProjection === 'function') {
    deps.eventStore.scheduleMessageProjection();
  }
}

export function createServerConductor(app: FastifyInstance, deps: ServerDeps) {
  // The conductor factory needs the app logger for background failures.
  const conductor = typeof deps.conductor === 'function' ? deps.conductor(app.log) : deps.conductor;
  deps.onConductorReady?.(conductor);
  return conductor;
}

export function createServerEventPublisher(deps: ServerDeps) {
  return (sessionId: string, event: AgentEvent): Promise<void> =>
    emitSessionEvent(deps.eventStore, deps.bus, sessionId, event);
}

export function createServerWorktrees(deps: ServerDeps) {
  const spawnWorktreeRoot = deps.spawnWorktreeRoot ?? join(tmpdir(), 'verity-sessions');
  // Real git worktree when injected (deployment); else an empty scratch dir.
  return deps.worktrees ?? createScratchProvisioner({ worktreeRoot: spawnWorktreeRoot });
}
