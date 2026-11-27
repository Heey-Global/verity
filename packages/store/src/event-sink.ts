import type { AgentEvent } from '@verity/events';

import type { SessionRecord } from './session-rows.js';

/** Input to `EventStore.createSession`: a {@link SessionRecord} whose
 * `name` is optional (a fresh session starts nameless unless the operator named
 * it at spawn). */
export type SessionInput = Omit<
  SessionRecord,
  'name' | 'projectId' | 'lastSeenEventCount' | 'planning'
> & {
  name?: string | null;
  projectId?: string | null;
  /** The person starting the session; its requests are theirs (ADR 0023). */
  createdByUserId?: string | null;
};

/**
 * The narrow persistence seam the Runner's ingest path drives (ADR 0006 D2). It
 * is EXACTLY the three `EventStore` methods the runner/ingest/backend
 * path touches — `appendEvent` (persist a stream event, returning its assigned
 * `seq`/`ts`), plus `createSession`/`getSession` for the session-bind bookkeeping.
 *
 * Retyping `RunTurnOptions.store` from the concrete `EventStore` to this
 * interface lets a Runner be handed a substitute sink (e.g. the Stage 2 file-sink
 * that writes events to the event stream file instead of the DB) WITHOUT the
 * Runner gaining DB access (D2: the Server persists; the Runner does not touch the
 * DB). The real `EventStore` `implements EventSink`, so every existing
 * caller passes it unchanged.
 */
export interface EventSink {
  appendEvent(
    sessionId: string,
    event: AgentEvent,
  ): Promise<{ seq: number; ts: number; existing?: true }>;
  createSession(session: SessionInput): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | undefined>;
}
