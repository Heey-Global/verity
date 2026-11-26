import { domainTopic, type DomainEvent, type DomainTopic } from '@verity/events';
import type { SessionRecord } from '@verity/store';
import type { PullRequestStatus } from '../forge-provider.js';
import type { ServerContext } from '../server-context.js';
import { createRevisions } from './revisions.js';

/** Sessions whose last published pull request status is remembered. A
 * forgotten session publishes its next status as new, which views apply like
 * any other. */
const MAX_REMEMBERED_SESSIONS = 4_096;

/**
 * Publishes a session's pull request status as `pr.status` (ADR 0033) when it
 * changes, so Home and the project page show a pull request that opened, went
 * green, failed or merged as soon as the server reads it, instead of at their
 * next list read.
 *
 * The returned function is called with every status the session pull request
 * cache presents, whichever read produced it: a view, the background sweep,
 * agent activity or the ready monitor. Only a status that differs from the
 * last one published for the session goes out, in the order the cache saw
 * them.
 *
 * The event carries the full status the overview routes show as `pullRequest`
 * (`null` when there is none or it is hidden), so views apply it without a
 * read. Wiki maintenance sessions, which the session list leaves out, reach
 * only their own session topic.
 */
export function createPrEvents(
  app: { log: { warn(obj: object, msg: string): void } },
  ctx: Pick<ServerContext, 'deps' | 'domainEvents'>,
): (session: SessionRecord, status: PullRequestStatus | null) => void {
  const { deps, domainEvents } = ctx;
  const revisions = createRevisions();
  const published = new Map<string, string>();
  const queues = new Map<string, Promise<void>>();

  const publish = async (
    session: SessionRecord,
    status: PullRequestStatus | null,
  ): Promise<void> => {
    const fingerprint = JSON.stringify(status);
    if (published.get(session.sessionId) === fingerprint) return;
    const topics: DomainTopic[] = [domainTopic('session', session.sessionId)];
    if (
      session.projectId !== null &&
      !(await isMaintenanceSession(deps.eventStore, session.sessionId))
    ) {
      topics.push(domainTopic('project', session.projectId));
    }
    const event: DomainEvent = {
      t: 'pr.status',
      sessionId: session.sessionId,
      rev: revisions.next(session.sessionId),
      pr: status === null ? null : { ...status },
    };
    for (const topic of topics) domainEvents.publish(topic, event);
    published.delete(session.sessionId);
    published.set(session.sessionId, fingerprint);
    if (published.size > MAX_REMEMBERED_SESSIONS) {
      published.delete(published.keys().next().value!);
    }
  };

  return (session, status) => {
    const previous = queues.get(session.sessionId) ?? Promise.resolve();
    const next = previous
      .then(() => publish(session, status))
      .catch((error: unknown) => {
        app.log.warn(
          { err: error, sessionId: session.sessionId },
          'verity: pull request event not published',
        );
      });
    queues.set(session.sessionId, next);
    void next.finally(() => {
      if (queues.get(session.sessionId) === next) queues.delete(session.sessionId);
    });
  };
}

/** Whether the session maintains a Wiki. A store without that record (a test
 * double) has none. */
async function isMaintenanceSession(store: object, sessionId: string): Promise<boolean> {
  const maintenance = (store as { wikiMaintenance?: { isSession?: unknown } }).wikiMaintenance;
  if (typeof maintenance?.isSession !== 'function') return false;
  return (maintenance as { isSession(id: string): Promise<boolean> }).isSession(sessionId);
}
