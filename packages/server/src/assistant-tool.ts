import { randomUUID } from 'node:crypto';
import {
  ASSISTANT_GRANT_INSTRUCTIONS,
  ASSISTANT_GRANT_LABELS,
  ASSISTANT_GRANT_PATH,
  assistantRequestSchema,
  DELEGATED_RESULTS_MAX_AGE_DAYS,
  DELEGATED_RESULTS_MAX_ENTRIES,
  type AssistantRequest,
} from '@verity/events';
import type {
  AssistantHandoff,
  AssistantMode,
  AssistantSettings,
  EventStore,
  SequencedEvent,
} from '@verity/store';
import { OnlineMeetingStartError } from './attendee-meetings.js';
import {
  CalendarEventAlreadyJoinedError,
  CalendarEventNotFoundError,
  type CalendarMeetingDeps,
} from './calendar-meeting-watcher.js';
import {
  canJoinNow,
  CalendarJoinWindowError,
  CalendarUnavailableError,
  joinWatchedMeeting,
  listUpcomingMeetings,
} from './calendar-meetings.js';
import {
  ControlPlaneSessionAuthorityError,
  ControlPlaneSessionToolError,
  SESSION_HANDOFF_TRANSCRIPT_LABEL,
  type ControlPlaneSessionToolDeps,
} from './session-handoff-tool.js';
import { redactSessionObservationText } from './session-observation.js';

export interface AssistantToolDeps {
  eventStore: EventStore;
  /** The user the calling turn runs for, from its prompt's `initiatedBy`. */
  initiator(sessionId: string, turnId: string): Promise<{ userId: string } | undefined>;
  /** Whether `userId` (undefined when auth is off) may use the project at this level. */
  permitted(
    userId: string | undefined,
    projectId: string,
    permission: 'read' | 'execute',
  ): Promise<boolean>;
  /** The watched meeting calendars; absent until the server has built them. */
  meetings?: CalendarMeetingDeps;
  /** Whether `userId` (undefined when auth is off) administers the server. The meeting
   *  calendars belong to the server's Google accounts, as on the start screen. */
  administrator?(userId: string | undefined): Promise<boolean>;
}

/** Every gateway tool the assistant session may call (docs/assistant.md). It reads untrusted
 *  mail and voice notes, so tools that write documents, publish knowledge, reach secrets or
 *  HTTP, or observe the fleet stay closed; a tool added to Control later is closed until it
 *  is listed here. */
export const ASSISTANT_TOOLS: ReadonlySet<string> = new Set([
  'verity_assistant',
  'verity_session_handoff',
  'verity_tasks',
  'verity_app_help',
  'verity_gmail',
  'verity_google_calendar',
  'verity_scheduling',
  'verity_google_contacts',
  'verity_start_planning',
  'verity_present_plan',
  'verity_end_planning',
]);

/** Why the gateway refuses `toolName` for `sessionId`, or undefined when this policy does
 *  not object. Only the assistant session is restricted; switched off, it keeps app help. */
export function assistantToolRefusal(
  settings: AssistantSettings,
  sessionId: string,
  toolName: string,
): string | undefined {
  if (settings.session_id !== sessionId) return undefined;
  if (!settings.enabled && toolName !== 'verity_app_help')
    return 'The Verity assistant is disabled in system settings.';
  if (!ASSISTANT_TOOLS.has(toolName))
    return 'The assistant reaches projects only through verity_assistant and handoffs to granted projects.';
  return undefined;
}

/** Refuses every caller except the enabled assistant session. Role identity is the stored
 *  session id, never the session's name or anything the agent could claim. */
export async function requireAssistantSession(
  eventStore: EventStore,
  sessionId: string,
): Promise<void> {
  const settings = await eventStore.assistant.settings();
  if (settings.session_id !== sessionId)
    throw new ControlPlaneSessionAuthorityError('This tool belongs to the Verity assistant.');
  if (!settings.enabled)
    throw new ControlPlaneSessionAuthorityError(
      'The Verity assistant is disabled in system settings.',
    );
}

/** The assistant's grant for a project at `needed` or above, for the turn's user. A missing
 *  grant, a deleted project or a user who lost access all refuse the same way, so the error
 *  does not reveal which projects exist. */
export async function requireAssistantGrant(
  deps: AssistantToolDeps,
  input: { sessionId: string; turnId: string; projectId: string },
  needed: Exclude<AssistantMode, 'off'>,
): Promise<{ userId: string | undefined; projectName: string }> {
  await requireAssistantSession(deps.eventStore, input.sessionId);
  const grant = await deps.eventStore.assistant.grant(input.projectId);
  const project = await deps.eventStore.getProject(input.projectId);
  const initiator = await deps.initiator(input.sessionId, input.turnId);
  if (
    grant === undefined ||
    (grant.mode !== 'delegate' && grant.mode !== needed) ||
    project === undefined ||
    project.hiddenAt !== null ||
    project.archived === true ||
    !(await deps.permitted(
      initiator?.userId,
      input.projectId,
      needed === 'delegate' ? 'execute' : 'read',
    ))
  )
    throw new ControlPlaneSessionAuthorityError(
      needed === 'delegate'
        ? `The assistant may not hand work to project ${input.projectId}. The user can choose "${ASSISTANT_GRANT_LABELS.delegate}" in that project's ${ASSISTANT_GRANT_PATH}.`
        : `The assistant has no access to project ${input.projectId}. The user can choose "${ASSISTANT_GRANT_LABELS.tasks}" or "${ASSISTANT_GRANT_LABELS.delegate}" in that project's ${ASSISTANT_GRANT_PATH}.`,
    );
  return { userId: initiator?.userId, projectName: `${project.owner}/${project.repo}` };
}

/**
 * The assistant's side of `verity_session_handoff`. Plain Control sessions keep their reach;
 * the assistant needs a "delegate" grant, and each briefing it delivers is recorded so
 * "delegated_results" can later read that session's published outcome — and nothing else.
 */
export function assistantHandoffHooks(
  deps: AssistantToolDeps,
): Pick<ControlPlaneSessionToolDeps, 'authorizeHandoffTarget' | 'recordHandoff'> {
  const isAssistant = async (sessionId: string) =>
    (await deps.eventStore.assistant.settings()).session_id === sessionId;
  return {
    authorizeHandoffTarget: async (input) => {
      if (await isAssistant(input.sessionId)) await requireAssistantGrant(deps, input, 'delegate');
    },
    recordHandoff: async (input) => {
      if (!(await isAssistant(input.callerSessionId))) return;
      const initiator = await deps.initiator(input.callerSessionId, input.turnId);
      await deps.eventStore.assistant.recordHandoff({
        targetSessionId: input.targetSessionId,
        assistantSessionId: input.callerSessionId,
        projectId: input.projectId,
        userId: initiator?.userId,
        title: input.title,
        handedOffAt: input.handedOffAt,
      });
    },
  };
}

/** How many of a target's newest events are searched for its published outcome. A summary
 *  buried deeper than that reads as "pending" rather than costing an unbounded log read. */
const DELEGATED_RESULT_EVENT_WINDOW = 500;
/** Event times come from the database, the handoff time from this process. */
const CLOCK_SKEW_MS = 5_000;

/** A `session_progress` event as the store returns it. */
type PublishedOutcome = SequencedEvent & {
  event: Extract<SequencedEvent['event'], { t: 'session_progress' }>;
};

/**
 * The outcome a briefed session published for this handoff, or undefined while it has none.
 * Shared by "delegated_results" and the announcement of results to the user, so both credit
 * exactly the same publication.
 */
export async function readDelegatedOutcome(
  deps: Pick<AssistantToolDeps, 'eventStore'>,
  handoff: AssistantHandoff,
): Promise<PublishedOutcome | undefined> {
  const since = handoff.handed_off_at.getTime();
  const { events } = await deps.eventStore.getEventsBeforeSeq(
    handoff.target_session_id,
    DELEGATED_RESULT_EVENT_WINDOW,
  );
  // Anchored on the briefing's own prompt, not on the time alone: a busy target queues the
  // briefing, and what its running turn publishes meanwhile answers something else. The
  // window ends at the next handoff into that session, whose result is another sender's.
  // Operator turns in between stay inside it: they often finish the briefed work.
  const isHandoff = (event: (typeof events)[number]['event']) =>
    event.t === 'prompt' && event.text.startsWith(SESSION_HANDOFF_TRANSCRIPT_LABEL);
  const briefing = events.findIndex(
    ({ ts, event }) =>
      ts >= since - CLOCK_SKEW_MS &&
      isHandoff(event) &&
      event.t === 'prompt' &&
      event.text.includes(`\n\nTitle: ${handoff.title}\n\n`),
  );
  const next =
    briefing < 0 ? -1 : events.findIndex((item, i) => i > briefing && isHandoff(item.event));
  const found =
    briefing < 0
      ? undefined
      : events
          .slice(briefing + 1, next < 0 ? undefined : next)
          .findLast((item): item is PublishedOutcome => item.event.t === 'session_progress');
  return found;
}

/**
 * What the sessions the assistant briefed have reported back since. Only the bounded,
 * credential-redacted fields a session publishes through `verity_publish_session_progress`
 * leave it — never transcript text — and only for handoffs made for this turn's user into
 * projects still granted to the assistant and readable by that user.
 */
async function delegatedResults(
  deps: AssistantToolDeps,
  input: { sessionId: string; turnId: string },
  sessionId: string | undefined,
) {
  const initiator = await deps.initiator(input.sessionId, input.turnId);
  const projects = new Map(
    (await assistantProjectsFor(deps, initiator?.userId)).map((project) => [
      project.projectId,
      project.name,
    ]),
  );
  const handoffs = (
    await deps.eventStore.assistant.handoffs({
      userId: initiator?.userId,
      since: new Date(Date.now() - DELEGATED_RESULTS_MAX_AGE_DAYS * 24 * 60 * 60 * 1000),
      // Over-fetched: grants are filtered below, and a revoked project must not take a slot.
      limit: 1_000,
    })
  ).filter(
    (handoff) =>
      projects.has(handoff.project_id) &&
      (sessionId === undefined || handoff.target_session_id === sessionId),
  );
  if (sessionId !== undefined && handoffs.length === 0)
    throw new ControlPlaneSessionToolError(
      `No recent handoff of yours went to session ${sessionId}.`,
    );
  const results = [];
  for (const handoff of handoffs.slice(0, DELEGATED_RESULTS_MAX_ENTRIES)) {
    const found = await readDelegatedOutcome(deps, handoff);
    const published = found?.event;
    results.push({
      sessionId: handoff.target_session_id,
      project: projects.get(handoff.project_id)!,
      title: handoff.title,
      handedOffAt: handoff.handed_off_at.toISOString(),
      ...(published?.t === 'session_progress'
        ? {
            state: 'reported',
            publishedAt: new Date(found!.ts).toISOString(),
            outcomeDelivered: published.outcomeDelivered,
            summary: redactSessionObservationText(published.summary),
            ...(published.blocker === undefined
              ? {}
              : { blocker: redactSessionObservationText(published.blocker) }),
            ...(published.requiredDecision === undefined
              ? {}
              : { requiredDecision: redactSessionObservationText(published.requiredDecision) }),
          }
        : { state: 'pending' }),
    });
  }
  return results;
}

/** The projects granted to the assistant that the turn's user may still read. */
async function grantedProjects(
  deps: AssistantToolDeps,
  input: { sessionId: string; turnId: string },
): Promise<{ projectId: string; name: string; mode: AssistantMode }[]> {
  const initiator = await deps.initiator(input.sessionId, input.turnId);
  return assistantProjectsFor(deps, initiator?.userId);
}

/**
 * The projects the assistant may use on behalf of `userId`: granted, live, and
 * readable by that user. The conversation routes put this list into each
 * message's context so a turn need not spend a model round asking for it; the
 * tool still checks the grant again when it acts.
 */
export async function assistantProjectsFor(
  deps: Pick<AssistantToolDeps, 'eventStore' | 'permitted'>,
  userId: string | undefined,
): Promise<{ projectId: string; name: string; mode: AssistantMode }[]> {
  const projects = new Map(
    (await deps.eventStore.listProjects()).map((project) => [project.id, project]),
  );
  const granted: { projectId: string; name: string; mode: AssistantMode }[] = [];
  for (const grant of await deps.eventStore.assistant.grants()) {
    const project = projects.get(grant.project_id);
    if (grant.mode === 'off' || !project || project.hiddenAt !== null || project.archived) continue;
    if (!(await deps.permitted(userId, project.id, 'read'))) continue;
    granted.push({
      projectId: project.id,
      name: `${project.owner}/${project.repo}`,
      mode: grant.mode,
    });
  }
  return granted;
}

/**
 * Scheduling requests still open in granted projects and the assistant's own session, plus
 * meetings booked through them that are still ahead. Guest links stay out: the assistant
 * reads untrusted mail and has no reason to hand a booking PIN on.
 */
async function schedulingOverview(
  deps: AssistantToolDeps,
  input: { sessionId: string; turnId: string },
) {
  // Execute access, as for the app's overview: a request is steered from its project.
  const initiator = await deps.initiator(input.sessionId, input.turnId);
  const names = new Map<string, string>();
  for (const project of await grantedProjects(deps, input))
    if (await deps.permitted(initiator?.userId, project.projectId, 'execute'))
      names.set(project.projectId, project.name);
  const now = Date.now();
  return (await deps.eventStore.scheduling.listRecent())
    .filter(
      (request) =>
        (request.sessionId === input.sessionId ||
          (request.projectId !== null && names.has(request.projectId))) &&
        (request.state === 'open' ||
          request.state === 'provisioning' ||
          (request.state === 'booked' &&
            request.bookedStart !== null &&
            request.bookedStart.getTime() > now)),
    )
    .map((request) => ({
      requestId: request.id,
      project: request.projectId === null ? null : (names.get(request.projectId) ?? null),
      state: request.state,
      title: request.title,
      guest: request.guestName ?? request.guestEmail,
      sentAt: request.emailSentAt?.toISOString() ?? null,
      closesAt: request.closesAt.toISOString(),
      ...(request.bookedStart ? { bookedStart: request.bookedStart.toISOString() } : {}),
    }));
}

/** A meeting refusal the assistant can relay; it never names another account's calendar. */
class AssistantMeetingError extends ControlPlaneSessionToolError {}

/** The watched calendars, for an administrator's turn only. */
async function meetingDeps(
  deps: AssistantToolDeps,
  input: { sessionId: string; turnId: string },
): Promise<CalendarMeetingDeps> {
  const initiator = await deps.initiator(input.sessionId, input.turnId);
  if (deps.meetings === undefined || deps.administrator === undefined)
    throw new AssistantMeetingError('Live meetings are not available on this server.');
  if (!(await deps.administrator(initiator?.userId)))
    throw new ControlPlaneSessionAuthorityError(
      'Live meetings from the calendar are available to administrators only.',
    );
  return deps.meetings;
}

async function meetingAction(
  deps: AssistantToolDeps,
  input: { sessionId: string; turnId: string },
  request: Extract<AssistantRequest, { action: 'meetings' | 'prepare_meeting' | 'join_meeting' }>,
): Promise<Record<string, unknown>> {
  const calendar = await meetingDeps(deps, input);
  try {
    if (request.action === 'meetings') {
      const at = (calendar.now ?? Date.now)();
      const meetings = await listUpcomingMeetings(calendar, {
        includeInPerson: request.includeInPerson === true,
      });
      return {
        meetings: meetings.map((meeting) => ({
          eventKey: meeting.eventKey,
          title: meeting.title,
          startsAt: new Date(meeting.startsAt).toISOString(),
          endsAt: new Date(meeting.endsAt).toISOString(),
          calendar: meeting.calendar,
          provider: meeting.provider,
          joinableNow: canJoinNow(meeting, at),
          ...(meeting.meetingId !== null ? { alreadyJoined: true } : {}),
        })),
      };
    }
    if (request.action === 'prepare_meeting') {
      // The phone fills in the start screen from the tool call; only a listed meeting may
      // be named, so the card never points at an event of an unwatched calendar.
      if (request.eventKey !== undefined) {
        const listed = (
          await listUpcomingMeetings(calendar, {
            includeInPerson: request.mode === 'in_person',
          })
        ).some((meeting) => meeting.eventKey === request.eventKey);
        if (!listed)
          throw new AssistantMeetingError(
            'That meeting is not in the watched calendars. List them with "meetings" first.',
          );
      }
      return { prepared: { sessionId: input.sessionId, mode: request.mode } };
    }
    try {
      const { meetingId } = await joinWatchedMeeting(calendar, request.eventKey, input.sessionId);
      return { joined: { sessionId: input.sessionId, meetingId } };
    } catch (error) {
      if (!(error instanceof CalendarEventAlreadyJoinedError)) throw error;
      const event = await calendar.store.calendarWatch.getEvent(request.eventKey);
      throw new AssistantMeetingError(
        event?.meetingId
          ? 'Verity is already in this meeting; the user can open it from the live meetings.'
          : error.message,
      );
    }
  } catch (error) {
    if (
      error instanceof CalendarEventNotFoundError ||
      error instanceof CalendarJoinWindowError ||
      error instanceof CalendarUnavailableError ||
      error instanceof OnlineMeetingStartError
    )
      throw new AssistantMeetingError(error.message);
    throw error;
  }
}

export async function executeAssistantTool(
  deps: AssistantToolDeps,
  input: { sessionId: string; turnId: string; request: unknown },
): Promise<Record<string, unknown>> {
  await requireAssistantSession(deps.eventStore, input.sessionId);
  const request = assistantRequestSchema.parse(input.request);
  // grantHelp is fixed text: projects without a grant stay unnamed, so the assistant learns
  // how a project is granted without learning which other projects exist.
  if (request.action === 'projects')
    return {
      projects: await grantedProjects(deps, input),
      grantHelp: `Projects not listed here are not granted to you, or do not exist. ${ASSISTANT_GRANT_INSTRUCTIONS}`,
    };
  if (request.action === 'scheduling') return { requests: await schedulingOverview(deps, input) };
  if (request.action === 'delegated_results')
    return { results: await delegatedResults(deps, input, request.sessionId) };
  if (
    request.action === 'meetings' ||
    request.action === 'prepare_meeting' ||
    request.action === 'join_meeting'
  )
    return meetingAction(deps, input, request);
  const { userId, projectName } = await requireAssistantGrant(
    deps,
    { ...input, projectId: request.projectId },
    'tasks',
  );
  // A task needs an owner. With auth off there is no initiator; the administrator who
  // enabled the assistant stands in, as the session runs on their behalf.
  const owner = userId ?? (await deps.eventStore.assistant.settings()).sponsor_user_id;
  if (!owner) throw new Error('No user to own the task; re-enable the assistant.');
  const task = await deps.eventStore.tasks.upsert({
    id: randomUUID(),
    ownerUserId: owner,
    projectId: request.projectId,
    sessionId: null,
    sourceSessionId: input.sessionId,
    origin: 'agent',
    title: request.title,
    detail: request.detail ?? null,
  });
  return { added: { id: task.id, title: task.title, project: projectName } };
}
