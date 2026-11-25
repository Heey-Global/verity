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
export function installOverviewEvents(
  app: { log: { warn(obj: object, msg: string): void } },
  ctx: ServerContext,
): void {
  const { deps, domainEvents, lifecycle } = ctx;
  const revisions = createRevisions();

  // Publication waits for the session's project; chaining it per session keeps
  // one session's events in revision order however the lookups resolve.
  const queues = new Map<string, Promise<void>>();
  const publish = (sessionId: string, event: DomainEvent): Promise<void> => {
    const previous = queues.get(sessionId) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        const session = await deps.eventStore.getSession(sessionId).catch(() => undefined);
        const topics: DomainTopic[] = [domainTopic('session', sessionId)];
        if (session?.projectId) topics.push(domainTopic('project', session.projectId));
        for (const topic of topics) domainEvents.publish(topic, event);
      })
      // A failed publication must not hold back the session's later events;
      // views still catch up through their next read.
      .catch((error: unknown) => {
        app.log.warn({ err: error, sessionId }, 'verity: overview event not published');
      })
      .finally(() => {
        if (queues.get(sessionId) === next) queues.delete(sessionId);
      });
    queues.set(sessionId, next);
    return next;
  };

  // Sessions whose last question is still open. Only those announce an answer:
  // every other prompt would cost each listening view an event for nothing. A
  // question posed before a restart is not tracked; its answer reaches views
  // through the session's status hint instead.
  const openQuestions = new Set<string>();
  const fromSessionEvent = (sessionId: string, event: AgentEvent): DomainEvent | undefined => {
    if (event.t === 'permission') {
      const rev = revisions.next(sessionId);
      return { t: 'permission.requested', sessionId, toolUseId: event.id, rev };
    }
    if (event.t === 'choices') {
      openQuestions.add(sessionId);
      if (openQuestions.size > 4_096) openQuestions.delete(openQuestions.values().next().value!);
      return { t: 'choices.opened', sessionId, rev: revisions.next(sessionId) };
    }
    if (event.t === 'prompt' && event.steered !== true && openQuestions.delete(sessionId)) {
      return { t: 'choices.answered', sessionId, rev: revisions.next(sessionId) };
    }
    return undefined;
  };

  const unsubscribe = deps.bus.subscribeAll((sessionId, { event }) => {
    if (event.t !== 'permission' && event.t !== 'choices' && event.t !== 'prompt') return;
    const domainEvent = fromSessionEvent(sessionId, event);
    if (domainEvent !== undefined) void publish(sessionId, domainEvent);
  });
  lifecycle.onClose(unsubscribe);

  const restore = observeDecisions(ctx.conductor, (sessionId, toolUseId, allowed) => {
    void publish(sessionId, {
      t: 'permission.decided',
      sessionId,
      toolUseId,
      rev: revisions.next(sessionId),
      outcome: allowed ? 'allowed' : 'denied',
    });
  });
  lifecycle.onClose(restore);
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
): () => void {
  // The real conductor inherits the method; an own property is put back as it was.
  const own = Object.getOwnPropertyDescriptor(conductor, 'decidePermission');
  const decide = conductor.decidePermission.bind(conductor);
  const observed: Conductor['decidePermission'] = async (
    sessionId,
    toolUseId,
    decision,
    options,
  ) => {
    const accepted = await decide(sessionId, toolUseId, decision, options);
    if (accepted) decided(sessionId, toolUseId, decision.behavior === 'allow');
    return accepted;
  };
  conductor.decidePermission = observed;
  // Undone on close, so a conductor that outlives this server reports nothing.
  return () => {
    if (conductor.decidePermission !== observed) return;
    if (own === undefined) delete (conductor as Partial<Conductor>).decidePermission;
    else Object.defineProperty(conductor, 'decidePermission', own);
  };
}
