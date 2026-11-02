import { type AgentEvent } from '@verity/events';
import { type EventBus } from '@verity/session';
import type { EventStore } from '@verity/store';
import './fastify-augmentation.js';

/** Store an event on a session and fan it out to its live stream. */
export async function emitSessionEvent(
  eventStore: EventStore,
  bus: EventBus,
  sessionId: string,
  event: AgentEvent,
): Promise<void> {
  const { seq, ts } = await eventStore.appendEvent(sessionId, event);
  bus.publish(sessionId, { seq, ts, event });
}

export async function emitNotice(input: {
  eventStore: EventStore;
  bus: EventBus;
  sessionId: string;
  text: string;
  role?: 'agent' | 'operator';
  clientRequestId?: string;
}): Promise<void> {
  const event: AgentEvent = {
    t: 'notice',
    text: input.text,
    ...(input.role ? { role: input.role } : {}),
    ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
  };
  const { seq, ts } = await input.eventStore.appendEvent(input.sessionId, event);
  input.bus.publish(input.sessionId, { seq, ts, event });
}
