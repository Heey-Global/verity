import type { AgentEvent } from '@verity/events';
import type { ChangeSubmission, EventStore, SessionRecord } from '@verity/store';
import type { FastifyInstance } from 'fastify';

import type { ServerContext } from './server-context.js';
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

/** The session's pull request, as far as a submission's status needs it. */
export interface SubmissionPullRequest {
  phase: PullRequestPhase;
  url?: string | undefined;
  headSha?: string | undefined;
}

/** The session's pull request unless it predates the submission: a PR merged
 *  before someone submitted new changes says nothing about those changes. */
function pullRequestSince(
  submission: Pick<ChangeSubmission, 'pullRequestUrl' | 'pullRequestHead' | 'revision'>,
  pr: SubmissionPullRequest | undefined,
): PullRequestPhase | undefined {
  if (pr === undefined) return undefined;
  // The same pull request counts once someone pushed to it after the submission,
  // or when it already carries exactly the submitted commit.
  const earlier =
    pr.url !== undefined &&
    pr.url === submission.pullRequestUrl &&
    pr.headSha === submission.pullRequestHead &&
    (pr.headSha === undefined || pr.headSha !== submission.revision);
  return earlier ? undefined : pr.phase;
}

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
    pr?: SubmissionPullRequest | undefined;
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
  live.forEach(({ submission, pr }, index) => {
    const checker = checkers[index];
    const prPhase = pullRequestSince(submission, pr);
    const status = changeSubmissionStatus({ state: submission.state, prPhase, checker });
    // Reads never write: a merged pull request shows as added here, and only a
    // member's next action stores it (see POST).
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

/** Where listed sessions' open submissions stand, read once per list load. */
export interface SubmissionListDeps {
  store: ChangeSubmissionStore;
  /** The session's pull request; read only for the few sessions with a submission. */
  pullRequest?: (session: SessionRecord) => Promise<SubmissionPullRequest | null | undefined>;
}

/** The open submissions among listed sessions, described once per list load. */
export async function openSubmissionViews(
  deps: SubmissionListDeps,
  summaries: readonly SessionRecord[],
): Promise<Map<string, ChangeSubmissionView>> {
  const open = await deps.store.changeSubmissions.open(summaries.map((s) => s.sessionId));
  if (open.size === 0) return new Map();
  const entries = await Promise.all(
    summaries.flatMap((summary) => {
      const submission = open.get(summary.sessionId);
      if (submission === undefined) return [];
      return [
        (async () => ({
          submission,
          projectId: summary.projectId,
          pr: (await deps.pullRequest?.(summary).catch(() => undefined)) ?? undefined,
        }))(),
      ];
    }),
  );
  return describeSubmissions(deps.store, entries);
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
  /** The session's pull request, if it has one. */
  pullRequest?: (session: SessionRecord) => Promise<SubmissionPullRequest | undefined>;
  /** Whether the session changed anything the project does not have yet. */
  hasChanges?: (session: SessionRecord) => Promise<boolean | undefined>;
}

export function registerChangeSubmissionRoutes(
  app: FastifyInstance,
  deps: ChangeSubmissionRouteDeps,
): void {
  /** `strict` lets a failed pull request read through instead of reading as none. */
  const describe = async (session: SessionRecord, strict = false) => {
    const submission = await deps.store.changeSubmissions.get(session.sessionId);
    if (submission === undefined) return null;
    const read = deps.pullRequest?.(session);
    const pr = strict ? await read : await read?.catch(() => undefined);
    const views = await describeSubmissions(deps.store, [
      { submission, projectId: session.projectId, pr },
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
    // Without accounts the one operator holds every right and nobody submits.
    if (viewer === null) {
      return { submission: null, viewerCanCode: true, viewerCanSubmit: false, shared: false };
    }
    const viewerCanCode = await holdsCode(deps.store, viewer, session.projectId);
    const viewerCanSubmit =
      !viewerCanCode &&
      session.projectId !== null &&
      (await deps.store.hasProjectPermission(viewer, session.projectId, 'execute'));
    // Only someone who could submit needs to know whether there is anything to submit.
    const hasChanges = viewerCanSubmit
      ? await deps.hasChanges?.(session).catch(() => undefined)
      : undefined;
    return {
      submission: await describe(session),
      // Absent when unreadable; the app then offers submitting anyway.
      ...(hasChanges === undefined ? {} : { hasChanges }),
      viewerCanCode,
      viewerCanSubmit,
      shared: true,
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
    // Whoever holds Code adds changes directly; there is nobody to hand them to.
    if (await holdsCode(deps.store, viewer, session.projectId)) {
      return reply.code(409).send({ error: 'You can add these changes yourself.' });
    }
    // The same rule as `viewerCanSubmit`, not only the route policy in front.
    if (
      session.projectId === null ||
      !(await deps.store.hasProjectPermission(viewer, session.projectId, 'execute'))
    ) {
      return reply.code(403).send({ error: 'Only members who may edit can submit changes.' });
    }
    // A second submission of the same changes would ask everyone again; one whose
    // changes were added already is done and makes room for new ones.
    if ((await deps.store.changeSubmissions.get(id))?.state === 'submitted') {
      const open = await describe(session);
      if (open?.status !== 'added') return reply.code(200).send({ submission: open });
      await deps.store.changeSubmissions.settle(id, 'added');
    }
    if ((await deps.hasChanges?.(session).catch(() => undefined)) === false) {
      return reply.code(409).send({ error: 'This session has no changes to submit.' });
    }
    let prUnread = false;
    const [revision, pr] = await Promise.all([
      deps.revision?.(session).catch(() => undefined),
      deps.pullRequest?.(session).catch(() => {
        prUnread = true;
        return undefined;
      }),
    ]);
    // Without knowing which pull request exists now, an earlier merged one could
    // later read as these changes being added.
    if (prUnread) {
      return reply.code(503).send({ error: 'Could not read the pull request. Try again.' });
    }
    const stored = await deps.store.changeSubmissions.submit({
      sessionId: id,
      userId: viewer,
      revision,
      // A pull request that exists now counts only once it moves past this point.
      pullRequestUrl: pr?.url,
      pullRequestHead: pr?.headSha,
    });
    // Another request submitted first; it has announced the submission.
    if (stored === undefined) return reply.code(200).send({ submission: await describe(session) });
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
    // What already landed cannot be taken back, and without the pull request it
    // is unknown whether it did.
    let current: ChangeSubmissionView | null;
    try {
      current = await describe(session, true);
    } catch {
      return reply.code(503).send({ error: 'Could not read the pull request. Try again.' });
    }
    if (current?.status === 'added') {
      return reply.code(409).send({ error: 'These changes were added already.' });
    }
    if (!(await deps.store.changeSubmissions.settle(id, 'withdrawn'))) {
      return reply.code(409).send({ error: 'Nothing is submitted in this session.' });
    }
    const by = viewer ?? submission.submittedBy;
    await deps.publish(id, {
      t: 'notice',
      text:
        by === submission.submittedBy
          ? `${await nameOf(by)} withdrew the submitted changes`
          : `${await nameOf(by)} turned down the submitted changes`,
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
