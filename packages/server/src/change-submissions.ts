import type { AgentEvent } from '@verity/events';
import type { ChangeSubmission, EventStore, SessionRecord } from '@verity/store';
import type { FastifyInstance } from 'fastify';

import type { ServerContext } from './server-context.js';
import type { SessionSummary } from './server-types.js';
import { holdsCode } from './session-request-addressees.js';

/**
 * Change submissions (ADR 0023): a member without Code submits a session's
 * changes, and members with Code check and add them. Where a submission stands is
 * derived rather than stored, so it cannot drift from what happened:
 *
 * - `waiting`  — nobody with Code has written in the session since;
 * - `checking` — someone with Code has, and the first of them is checking;
 * - `adding`   — the session has an open pull request;
 * - `added`    — its pull request was merged, or it was saved to the project.
 */
export type ChangeSubmissionStatus = 'waiting' | 'checking' | 'adding' | 'added';

export interface ChangeSubmissionPerson {
  id: string;
  /** Absent when the person chose no display name. */
  name?: string;
}

export interface ChangeSubmissionView {
  status: ChangeSubmissionStatus;
  submittedBy: ChangeSubmissionPerson;
  /** The first member with Code who wrote after the submission. */
  checker?: ChangeSubmissionPerson;
  submittedAt: number;
}

export type PullRequestPhase = 'open' | 'merged' | 'closed';

export function changeSubmissionStatus(input: {
  state: ChangeSubmission['state'];
  prPhase?: PullRequestPhase | undefined;
  checker?: string | undefined;
}): ChangeSubmissionStatus | undefined {
  if (input.state === 'withdrawn') return undefined;
  if (input.state === 'added' || input.prPhase === 'merged') return 'added';
  if (input.prPhase === 'open') return 'adding';
  return input.checker === undefined ? 'waiting' : 'checking';
}

export type ChangeSubmissionStore = Pick<
  EventStore,
  'changeSubmissions' | 'isActiveAdministrator' | 'hasProjectPermission' | 'userDisplayNames'
>;

/** Describes submissions, reading who wrote since and their rights once per call. */
export async function describeSubmissions(
  store: ChangeSubmissionStore,
  entries: readonly {
    submission: ChangeSubmission;
    projectId: string | null;
    prPhase?: PullRequestPhase | undefined;
  }[],
): Promise<Map<string, ChangeSubmissionView>> {
  const views = new Map<string, ChangeSubmissionView>();
  const live = entries.filter((entry) => entry.submission.state !== 'withdrawn');
  if (live.length === 0) return views;
  const writers = await store.changeSubmissions.writersSince(live.map((e) => e.submission));
  const rights = new Map<string, Promise<boolean>>();
  const mayCode = (userId: string, projectId: string | null) => {
    const key = `${userId}\0${projectId ?? ''}`;
    let held = rights.get(key);
    if (held === undefined) {
      held = holdsCode(store, userId, projectId).catch(() => false);
      rights.set(key, held);
    }
    return held;
  };
  const checkers = await Promise.all(
    live.map(async ({ submission, projectId }) => {
      for (const writer of writers.get(submission.sessionId) ?? []) {
        if (writer !== submission.submittedBy && (await mayCode(writer, projectId))) return writer;
      }
      return undefined;
    }),
  );
  const people = new Set<string>();
  live.forEach((entry, index) => {
    people.add(entry.submission.submittedBy);
    const checker = checkers[index];
    if (checker !== undefined) people.add(checker);
  });
  const names = await store.userDisplayNames([...people]).catch(() => new Map<string, string>());
  const person = (id: string): ChangeSubmissionPerson => {
    const name = names.get(id);
    return name === undefined ? { id } : { id, name };
  };
  live.forEach(({ submission, prPhase }, index) => {
    const checker = checkers[index];
    const status = changeSubmissionStatus({ state: submission.state, prPhase, checker });
    if (status === undefined) return;
    views.set(submission.sessionId, {
      status,
      submittedBy: person(submission.submittedBy),
      ...(checker === undefined ? {} : { checker: person(checker) }),
      submittedAt: submission.submittedAt.getTime(),
    });
  });
  return views;
}

/** The open submissions among listed sessions, described once per list load. */
export async function openSubmissionViews(
  store: ChangeSubmissionStore,
  summaries: readonly Pick<SessionSummary, 'sessionId' | 'projectId' | 'pr'>[],
): Promise<Map<string, ChangeSubmissionView>> {
  const open = await store.changeSubmissions.open(summaries.map((s) => s.sessionId));
  if (open.size === 0) return new Map();
  return describeSubmissions(
    store,
    summaries.flatMap((summary) => {
      const submission = open.get(summary.sessionId);
      return submission === undefined
        ? []
        : [{ submission, projectId: summary.projectId, prPhase: summary.pr?.phase }];
    }),
  );
}

/**
 * Whether a submission waits on `viewer`: everyone with Code until one of them
 * writes, then only that person, until the changes are added.
 */
export function submissionAddressedTo(
  viewer: string,
  view: ChangeSubmissionView,
  viewerHoldsCode: boolean,
): boolean {
  if (view.status === 'added' || view.submittedBy.id === viewer || !viewerHoldsCode) return false;
  return view.checker === undefined || view.checker.id === viewer;
}

export interface ChangeSubmissionRouteDeps {
  store: ChangeSubmissionStore & Pick<EventStore, 'getSession'>;
  publish: (sessionId: string, event: AgentEvent) => Promise<unknown>;
  /** The commit the session's branch is at, when it can be read. */
  revision?: (session: SessionRecord) => Promise<string | undefined>;
  /** The phase of the session's pull request, if it has one. */
  prPhase?: (session: SessionRecord) => Promise<PullRequestPhase | undefined>;
  /** Whether the session changed anything the project does not have yet. */
  hasChanges?: (session: SessionRecord) => Promise<boolean | undefined>;
}

export function registerChangeSubmissionRoutes(
  app: FastifyInstance,
  deps: ChangeSubmissionRouteDeps,
): void {
  const describe = async (session: SessionRecord) => {
    const submission = await deps.store.changeSubmissions.get(session.sessionId);
    if (submission === undefined) return null;
    const prPhase = await deps.prPhase?.(session).catch(() => undefined);
    const views = await describeSubmissions(deps.store, [
      { submission, projectId: session.projectId, prPhase },
    ]);
    return views.get(session.sessionId) ?? null;
  };
  const nameOf = async (userId: string) =>
    (await deps.store.userDisplayNames([userId]).catch(() => new Map<string, string>())).get(
      userId,
    ) ?? 'A member';

  app.get('/sessions/:id/change-submission', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = await deps.store.getSession(id);
    if (session === undefined) return reply.code(404).send({ error: 'session not found' });
    const viewer = request.localUserId ?? null;
    const hasChanges = await deps.hasChanges?.(session).catch(() => undefined);
    return {
      submission: await describe(session),
      // Absent when unreadable; the app then offers submitting anyway.
      ...(hasChanges === undefined ? {} : { hasChanges }),
      // Without accounts the one operator holds every right.
      viewerCanCode: viewer === null || (await holdsCode(deps.store, viewer, session.projectId)),
    };
  });

  app.post('/sessions/:id/change-submission', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = await deps.store.getSession(id);
    if (session === undefined) return reply.code(404).send({ error: 'session not found' });
    const viewer = request.localUserId ?? null;
    if (viewer === null) {
      return reply.code(409).send({ error: 'Submitting changes needs member accounts.' });
    }
    const revision = await deps.revision?.(session).catch(() => undefined);
    await deps.store.changeSubmissions.submit({ sessionId: id, userId: viewer, revision });
    await deps.publish(id, {
      t: 'notice',
      text: `${await nameOf(viewer)} submitted changes`,
      changeSubmission: { action: 'submitted', userId: viewer },
    });
    return reply.code(201).send({ submission: await describe(session) });
  });

  app.delete('/sessions/:id/change-submission', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = await deps.store.getSession(id);
    if (session === undefined) return reply.code(404).send({ error: 'session not found' });
    const submission = await deps.store.changeSubmissions.get(id);
    if (submission?.state !== 'submitted') {
      return reply.code(409).send({ error: 'Nothing is submitted in this session.' });
    }
    const viewer = request.localUserId ?? null;
    // The person who submitted withdraws; a member with Code may turn it down.
    if (
      viewer !== null &&
      viewer !== submission.submittedBy &&
      !(await holdsCode(deps.store, viewer, session.projectId))
    ) {
      return reply.code(403).send({ error: 'Only the person who submitted can withdraw.' });
    }
    if (!(await deps.store.changeSubmissions.settle(id, 'withdrawn'))) {
      return reply.code(409).send({ error: 'Nothing is submitted in this session.' });
    }
    const by = viewer ?? submission.submittedBy;
    await deps.publish(id, {
      t: 'notice',
      text: `${await nameOf(by)} withdrew the submitted changes`,
      changeSubmission: { action: 'withdrawn', userId: by },
    });
    return { submission: null };
  });
}

export function installChangeSubmissions(
  app: FastifyInstance,
  ctx: ServerContext,
  wiring: Omit<ChangeSubmissionRouteDeps, 'store'>,
): void {
  registerChangeSubmissionRoutes(app, { store: ctx.deps.eventStore, ...wiring });
}
