import type { SessionRecord } from '@verity/store';
import type { PullRequestStatus } from './github.js';
import type { PushForegroundPresence } from './push-fire-points.js';
import type { PushLogger, PushNotification, PushSender } from './push-sender.js';

const DEFAULT_POLL_MS = 30_000;

export interface PushSessionContext {
  project?: string | undefined;
  session?: string | undefined;
}

export interface PullRequestReadyMonitor {
  runOnce(): Promise<void>;
  stop(): Promise<void>;
}

export interface PullRequestReadyMonitorOptions {
  sender: PushSender;
  presence: PushForegroundPresence;
  listSessions(): Promise<SessionRecord[]>;
  statusFor(session: SessionRecord): Promise<PullRequestStatus | null>;
  wasSent(sessionId: string, marker: string): Promise<boolean>;
  markSent(sessionId: string, marker: string): Promise<boolean>;
  describeSession(session: SessionRecord): Promise<PushSessionContext>;
  logger?: PushLogger | undefined;
  pollMs?: number | undefined;
}

function shorten(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function pullRequestReadyMarker(pr: PullRequestStatus): string {
  const revision = pr.headSha ?? pr.updatedAt ?? 'unknown';
  return `pr-ready:${String(pr.number)}:${revision}`;
}

export function buildPullRequestReadyNotification(
  sessionId: string,
  pr: PullRequestStatus,
  context: PushSessionContext,
): PushNotification {
  const project = context.project?.trim() || 'Verity';
  const session = context.session?.trim();
  const detail = session ? `${pr.title} · ${session}` : pr.title;
  return {
    title: shorten(`${project} · PR #${String(pr.number)} ready`, 100),
    body: shorten(`${detail} — all checks passed.`, 220),
    categoryId: 'PULL_REQUEST_READY',
    data: { sessionId, kind: 'pull_request_ready', pullRequestNumber: pr.number },
    priority: 'high',
  };
}

function isReady(pr: PullRequestStatus | null): pr is PullRequestStatus {
  return pr?.phase === 'open' && pr.pipeline === 'success' && pr.mergeable === true;
}

export function startPullRequestReadyMonitor(
  options: PullRequestReadyMonitorOptions,
): PullRequestReadyMonitor {
  let stopped = false;
  let active: Promise<void> | undefined;
  const pending = new Set<string>();

  const inspect = async (session: SessionRecord): Promise<void> => {
    if (options.presence.hasViewer(session.sessionId)) return;
    const pr = await options.statusFor(session);
    if (!isReady(pr) || options.presence.hasViewer(session.sessionId)) return;
    const marker = pullRequestReadyMarker(pr);
    const pendingKey = `${session.sessionId}\0${marker}`;
    if (pending.has(pendingKey) || (await options.wasSent(session.sessionId, marker))) return;
    pending.add(pendingKey);
    try {
      const context = await options.describeSession(session);
      const result = await options.sender.send(
        buildPullRequestReadyNotification(session.sessionId, pr, context),
      );
      // A ready PR discovered before any device registers must remain eligible;
      // likewise, an all-error batch should retry after token refresh/pruning.
      if (result.targets === 0 || result.ticketsAccepted === 0) return;
      await options.markSent(session.sessionId, marker);
    } catch {
      options.logger?.warn(
        { component: 'push', kind: 'pull_request_ready' },
        'verity: PR-ready push failed',
      );
    } finally {
      pending.delete(pendingKey);
    }
  };

  const runOnce = async (): Promise<void> => {
    if (stopped || active !== undefined) return active;
    active = (async () => {
      const sessions = await options.listSessions();
      for (const session of sessions) {
        if (stopped) break;
        await inspect(session).catch(() => undefined);
      }
    })()
      // The BATCH is caught, not only each session. `inspect` was already
      // guarded; `listSessions` was not, and it is the first thing every poll
      // does and the only one that reaches the control-plane database. Nothing
      // awaits the promise this assigns — the interval below discards it and
      // `stop()` only joins a batch that is still running — so a rejection from
      // `listSessions` reached node as an unhandled rejection and killed the
      // process.
      //
      // That is not a push failure, it is the Server's whole availability: the
      // control-plane keeper is given a reconnect budget precisely so an
      // ordinary PostgreSQL restart is survivable (see
      // CONTROL_PLANE_RECONNECT_BUDGET_MS), and this poller spent that budget at
      // the first tick after the database went quiet — taking the Server down
      // over a notification it could simply have skipped.
      .catch(() => {
        options.logger?.warn(
          { component: 'push', kind: 'pull_request_ready' },
          'verity: PR-ready poll could not list sessions',
        );
      })
      .finally(() => {
        active = undefined;
      });
    return active;
  };

  const timer = setInterval(() => void runOnce(), options.pollMs ?? DEFAULT_POLL_MS);
  timer.unref?.();
  void runOnce();

  return {
    runOnce,
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  };
}
