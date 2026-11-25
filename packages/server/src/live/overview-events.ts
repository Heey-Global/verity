import { domainTopic, type AgentEvent, type DomainEvent, type DomainTopic } from '@verity/events';
import type { ServerContext } from '../server-context.js';

type Conductor = ServerContext['conductor'];

/**
 * Publishes the overview changes of secret and permission requests and of
 * Quick Actions as domain events (ADR 0033), so Home, the project page and
 * every other device drop an answered card at once instead of after their
 * next list read.
 *
 * Events carry ids only. A newly opened request or question is announced, and
 * views read its content through the overview routes, which keep deciding
 * what each viewer may see.
 *
 * Sources:
 * - the session event bus: `permission` (a request surfaced), `choices` (a
 *   question posed), and a non-steered `prompt` (which answers a question);
 * - the conductor's permission decisions, which no session event records. Every
 *   decision — from the card, a notification, a standing grant, or a detached
 *   secret approval — passes through `decidePermission`.
 */
export function installOverviewEvents(ctx: ServerContext): void {
  const { deps, domainEvents, lifecycle } = ctx;
  const revisions = createRevisions();

  const publish = async (sessionId: string, event: DomainEvent): Promise<void> => {
    const session = await deps.eventStore.getSession(sessionId).catch(() => undefined);
    const topics: DomainTopic[] = [domainTopic('session', sessionId)];
    if (session?.projectId) topics.push(domainTopic('project', session.projectId));
    for (const topic of topics) domainEvents.publish(topic, event);
  };

  const fromSessionEvent = (sessionId: string, event: AgentEvent): DomainEvent | undefined => {
    const rev = revisions.next(sessionId);
    if (event.t === 'permission') {
      return { t: 'permission.requested', sessionId, toolUseId: event.id, rev };
    }
    if (event.t === 'choices') return { t: 'choices.opened', sessionId, rev };
    if (event.t === 'prompt' && event.steered !== true) {
      return { t: 'choices.answered', sessionId, rev };
    }
    return undefined;
  };

  const unsubscribe = deps.bus.subscribeAll((sessionId, { event }) => {
    if (event.t !== 'permission' && event.t !== 'choices' && event.t !== 'prompt') return;
    const domainEvent = fromSessionEvent(sessionId, event);
    if (domainEvent !== undefined) void publish(sessionId, domainEvent);
  });
  lifecycle.onClose(unsubscribe);

  observeDecisions(ctx.conductor, (sessionId, toolUseId, allowed) => {
    void publish(sessionId, {
      t: 'permission.decided',
      sessionId,
      toolUseId,
      rev: revisions.next(sessionId),
      outcome: allowed ? 'allowed' : 'denied',
    });
  });
}

/** Per-session revisions that keep increasing across server restarts: a view
 * compares them with revisions it received from the previous process. */
function createRevisions(now: () => number = Date.now) {
  const last = new Map<string, number>();
  return {
    next(sessionId: string): number {
      const rev = Math.max(now(), (last.get(sessionId) ?? 0) + 1);
      last.set(sessionId, rev);
      // Bounded: a forgotten session restarts from the clock, which still
      // orders after anything it published before.
      if (last.size > 4_096) last.delete(last.keys().next().value!);
      return rev;
    },
  };
}

/**
 * Report every accepted permission decision. The conductor records none as a
 * session event and its source has no seam for one, so the decision method is
 * wrapped on this instance; its own internal calls (standing grants) go through
 * the instance property and are reported too.
 */
function observeDecisions(
  conductor: Conductor,
  decided: (sessionId: string, toolUseId: string, allowed: boolean) => void,
): void {
  const decide = conductor.decidePermission.bind(conductor);
  conductor.decidePermission = async (sessionId, toolUseId, decision, options) => {
    const accepted = await decide(sessionId, toolUseId, decision, options);
    if (accepted) decided(sessionId, toolUseId, decision.behavior === 'allow');
    return accepted;
  };
}
