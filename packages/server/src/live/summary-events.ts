import {
  SESSION_SUMMARY_FIELDS,
  domainTopic,
  type DomainTopic,
  type LiveHintTopic,
} from '@verity/events';
import type { SessionRecord } from '@verity/store';
import type { ServerContext } from '../server-context.js';
import type { SessionSummary } from '../server-types.js';
import { planningPresented } from '../session-row.js';
import { ObservedSet } from '../observed-set.js';
import { isMaintenanceSession } from './pr-events.js';
import { createRevisions } from './revisions.js';

/** A session's first hint waits this long and a long burst publishes at
 * least this often, so one burst is one row. */
const SETTLE_MS = 300;
const MAX_WAIT_MS = 2_000;
/** Sessions whose last published revision is remembered for the list rows. */
const MAX_REMEMBERED_SESSIONS = 4_096;
/** Attempts for a row that could not be computed, each after a longer wait. */
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];

type Row = Record<string, unknown>;
/** The hints a changed row raises; `activity` and `permission` come with one of them. */
const ROW_TOPICS: ReadonlySet<LiveHintTopic> = new Set(['session', 'status', 'events']);

/** The row every viewer's list shows alike ({@link SESSION_SUMMARY_FIELDS}),
 * with `planningPresented` derived as `/sessions` derives it. */
export function sharedRow(summary: SessionSummary): Row {
  const source: Record<string, unknown> = { ...summary, ...planningPresented(summary) };
  const row: Row = {};
  for (const key of SESSION_SUMMARY_FIELDS) {
    if (source[key] !== undefined) row[key] = source[key];
  }
  return row;
}

/**
 * Publishes a session's overview row as `session.summary` (ADR 0033): its
 * status, activity, unread count, usage and the other fields every viewer sees
 * alike, whole. Home and the project page then follow a session without
 * reading the whole list again for each status change or burst of transcript.
 *
 * Every change hinted to the overview as `session`, `status` or `events`
 * schedules the row, whatever raised it: a session event, a process that
 * ended, a repair, a name the session gave itself. So does the project's
 * sandbox losing or regaining the broker, which every session of the project
 * shows.
 * Home skips its list read for those hints once it follows the project, so
 * none may go without a row. A burst becomes one row after it settles, and a
 * long burst one row at least every {@link MAX_WAIT_MS}; a row that could
 * not be computed is tried again.
 * Wiki maintenance sessions, which the lists leave out, reach only their own
 * session topic.
 */
export function installSummaryEvents(
  app: { log: { warn(obj: object, msg: string): void } },
  ctx: Pick<ServerContext, 'deps' | 'domainEvents' | 'lifecycle' | 'liveHub'>,
  summarize: (sessions: SessionRecord[]) => Promise<SessionSummary[]>,
  timers: {
    setTimeout: (run: () => void, ms: number) => unknown;
    clearTimeout: (timer: unknown) => void;
    now: () => number;
  } = {
    setTimeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    now: Date.now,
  },
): { summaryRevision: (sessionId: string) => number | undefined } {
  const { deps, domainEvents, lifecycle } = ctx;
  const revisions = createRevisions();
  /** The revision each session's latest row took when its computation began;
   * bounded, so a forgotten session's list rows carry none. */
  const lastRevisions = new Map<string, number>();
  const scheduled = new Map<string, { timer: unknown; since: number }>();
  const queues = new Map<string, Promise<void>>();
  let closed = false;

  const publish = async (sessionId: string): Promise<void> => {
    // Taken before the row is computed, so a list read that took its revisions
    // after this one began holds a later state and views keep it.
    const rev = revisions.next();
    // Reads stamped from now on hold a state at least as new as this row.
    lastRevisions.delete(sessionId);
    lastRevisions.set(sessionId, rev);
    if (lastRevisions.size > MAX_REMEMBERED_SESSIONS)
      lastRevisions.delete(lastRevisions.keys().next().value!);
    const session = await deps.eventStore.getSession(sessionId);
    if (session === undefined || closed) return;
    const [summary] = await summarize([session]);
    if (summary === undefined || closed) return;
    // The whole row, even when it equals the last one: a view may hold a
    // state its own read took in between.
    const row = sharedRow(summary);
    const topics: DomainTopic[] = [domainTopic('session', sessionId)];
    if (session.projectId !== null && !(await isMaintenanceSession(deps.eventStore, sessionId)))
      topics.push(domainTopic('project', session.projectId));
    if (closed) return;
    const event = {
      t: 'session.summary' as const,
      sessionId,
      rev,
      patch: row,
    };
    for (const topic of topics) domainEvents.publish(topic, event);
  };

  // One computation per session at a time, in order, so patches build on the
  // row the previous one published.
  const run = (sessionId: string, attempt = 0): void => {
    scheduled.delete(sessionId);
    const previous = queues.get(sessionId) ?? Promise.resolve();
    const next = previous
      .then(() => publish(sessionId))
      // The hint that scheduled this row may be the session's last; try again.
      .catch((error: unknown) => {
        app.log.warn({ err: error, sessionId }, 'verity: session summary not published');
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay !== undefined && !closed && !scheduled.has(sessionId))
          scheduled.set(sessionId, {
            timer: timers.setTimeout(() => run(sessionId, attempt + 1), delay),
            since: timers.now(),
          });
      })
      .finally(() => {
        if (queues.get(sessionId) === next) queues.delete(sessionId);
      });
    queues.set(sessionId, next);
  };

  const schedule = (sessionId: string): void => {
    if (closed) return;
    const now = timers.now();
    const pending = scheduled.get(sessionId);
    const since = pending?.since ?? now;
    if (pending !== undefined) timers.clearTimeout(pending.timer);
    const wait = Math.max(0, Math.min(SETTLE_MS, since + MAX_WAIT_MS - now));
    scheduled.set(sessionId, { timer: timers.setTimeout(() => run(sessionId), wait), since });
  };

  const unsubscribe = ctx.liveHub.onNotify((change) => {
    if (change.deleted === true) {
      lastRevisions.delete(change.sessionId);
      return;
    }
    if (change.topics.some((topic) => ROW_TOPICS.has(topic))) schedule(change.sessionId);
  });
  // The provisioner's reconciler classifies sandboxes without a hint of its
  // own; each session of the project names the condition in its row. The
  // projects one pass reclassifies share one read of the sessions.
  let changedProjects: Set<string> | undefined;
  let announceTimer: unknown;
  /** The failed reads the pending batch follows; 0 for a fresh change. */
  let batchAttempt = 0;
  const retryDelay = (attempt: number): number =>
    attempt === 0 ? 0 : RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length) - 1]!;
  // A fresh change is read at once, even when a retry is waiting; a retry that
  // joins a fresh batch keeps its place on the backoff ladder.
  const noteProjects = (projectIds: Iterable<string>, attempt: number): void => {
    if (changedProjects === undefined || attempt < batchAttempt) {
      if (announceTimer !== undefined) timers.clearTimeout(announceTimer);
      announceTimer = timers.setTimeout(announceProjects, retryDelay(attempt));
    }
    changedProjects ??= new Set();
    batchAttempt = changedProjects.size === 0 ? attempt : Math.max(batchAttempt, attempt);
    for (const projectId of projectIds) changedProjects.add(projectId);
  };
  const announceProjects = (): void => {
    const projectIds = changedProjects;
    const attempt = batchAttempt;
    changedProjects = undefined;
    announceTimer = undefined;
    if (projectIds === undefined || closed) return;
    void deps.eventStore
      .listSessions()
      .then((sessions) => {
        if (closed) return;
        for (const session of sessions)
          if (session.projectId !== null && projectIds.has(session.projectId))
            schedule(session.sessionId);
      })
      .catch((error: unknown) => {
        app.log.warn(
          { err: error, projectIds: [...projectIds] },
          'verity: sandbox sessions not announced',
        );
        // Nothing else hints these sessions: read them again, waiting longer
        // each time up to the last delay.
        if (!closed) noteProjects(projectIds, attempt + 1);
      });
  };
  const disconnected = deps.provisioner?.disconnectedSandboxProjects?.();
  const stopObservingSandboxes =
    disconnected instanceof ObservedSet
      ? (disconnected as ObservedSet<string>).observe((projectId) => {
          noteProjects([projectId], 0);
        })
      : undefined;
  lifecycle.onClose(() => {
    closed = true;
    unsubscribe();
    stopObservingSandboxes?.();
    if (announceTimer !== undefined) timers.clearTimeout(announceTimer);
    for (const { timer } of scheduled.values()) timers.clearTimeout(timer);
    scheduled.clear();
  });
  return { summaryRevision: (sessionId) => lastRevisions.get(sessionId) };
}
