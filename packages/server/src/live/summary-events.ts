import { domainTopic, type DomainTopic } from '@verity/events';
import type { SessionRecord } from '@verity/store';
import type { ServerContext } from '../server-context.js';
import type { SessionSummary } from '../server-types.js';
import { isMaintenanceSession } from './pr-events.js';
import { createRevisions } from './revisions.js';

/** A session's row is computed again at most this often while events arrive,
 * and its first event waits this long, so one burst is one patch. */
const SETTLE_MS = 300;
const MAX_WAIT_MS = 2_000;
/** Sessions whose last published row is remembered. A forgotten session
 * publishes its whole row again, marked `full`. */
const MAX_REMEMBERED_SESSIONS = 4_096;
/** Further attempts for a row that could not be computed. */
const MAX_RETRIES = 2;

/**
 * Fields of a row the summary event does not carry:
 * - per viewer, added by the list routes (read marks, dismissed items, the
 *   person a request is addressed to, review submissions, link and order);
 * - owned by other overview events, whose views read the content
 *   (`permission.*`, `choices.*`, `pr.status`);
 * - text a list route leaves out (`planningPlan`, `requestInitiator`).
 */
const NOT_CARRIED: ReadonlySet<string> = new Set([
  'lastSeenEventCount',
  'inboxDismissed',
  'addressedToViewer',
  'changeSubmission',
  'linked',
  'sortOrder',
  'pendingPermissions',
  'pendingPermissionRequests',
  'permissionAwaitingInput',
  'openChoices',
  'pr',
  'pullRequest',
  'planningPlan',
  'requestInitiator',
]);

type Row = Record<string, unknown>;

/** The row as every viewer's list shows it, before the routes add their own
 * fields; `planningPresented` as `/sessions` derives it. */
export function sharedRow(summary: SessionSummary): Row {
  const row: Row = {};
  for (const [key, value] of Object.entries(summary)) {
    if (!NOT_CARRIED.has(key) && value !== undefined) row[key] = value;
  }
  if (summary.planning === 'active' && summary.planningPlan != null) row.planningPresented = true;
  return row;
}

/** The changed fields of `next` and the fields it no longer has. Without a
 * `previous` row, the whole of `next` marked `full`. */
export function rowPatch(
  previous: Row | undefined,
  next: Row,
): { patch: Row; unset?: string[]; full?: true } | undefined {
  if (previous === undefined) return { patch: next, full: true };
  const patch: Row = {};
  for (const [key, value] of Object.entries(next)) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(value)) patch[key] = value;
  }
  const unset = Object.keys(previous).filter((key) => !(key in next));
  if (Object.keys(patch).length === 0 && unset.length === 0) return undefined;
  return unset.length > 0 ? { patch, unset } : { patch };
}

/**
 * Publishes a session's overview row as `session.summary` (ADR 0033) when it
 * changes: its status, activity, unread count, usage and the other fields
 * every viewer sees alike. Home and the project page then follow a session
 * without reading the whole list again for each status change or each burst
 * of transcript.
 *
 * Every change hinted to the overview as `status` or `events` schedules the
 * row, whatever raised it: a session event, a process that ended, a repair.
 * Home skips its list read for those hints once it follows the project, so
 * none may go without a row. A burst becomes one patch after it settles, and a
 * long burst one patch at least every {@link MAX_WAIT_MS}; a row that could
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
): void {
  const { deps, domainEvents, lifecycle } = ctx;
  const revisions = createRevisions();
  const published = new Map<string, Row>();
  const scheduled = new Map<string, { timer: unknown; since: number }>();
  const queues = new Map<string, Promise<void>>();
  let closed = false;

  const publish = async (sessionId: string): Promise<void> => {
    const session = await deps.eventStore.getSession(sessionId);
    if (session === undefined || closed) return;
    const [summary] = await summarize([session]);
    if (summary === undefined || closed) return;
    const row = sharedRow(summary);
    const change = rowPatch(published.get(sessionId), row);
    if (change === undefined) return;
    const topics: DomainTopic[] = [domainTopic('session', sessionId)];
    if (session.projectId !== null && !(await isMaintenanceSession(deps.eventStore, sessionId)))
      topics.push(domainTopic('project', session.projectId));
    const event = {
      t: 'session.summary' as const,
      sessionId,
      rev: revisions.next(sessionId),
      ...change,
    };
    for (const topic of topics) domainEvents.publish(topic, event);
    published.delete(sessionId);
    published.set(sessionId, row);
    if (published.size > MAX_REMEMBERED_SESSIONS) published.delete(published.keys().next().value!);
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
        if (attempt < MAX_RETRIES && !closed && !scheduled.has(sessionId))
          scheduled.set(sessionId, {
            timer: timers.setTimeout(() => run(sessionId, attempt + 1), MAX_WAIT_MS),
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
      published.delete(change.sessionId);
      return;
    }
    if (change.topics.some((topic) => topic === 'status' || topic === 'events'))
      schedule(change.sessionId);
  });
  lifecycle.onClose(() => {
    closed = true;
    unsubscribe();
    for (const { timer } of scheduled.values()) timers.clearTimeout(timer);
    scheduled.clear();
  });
}
