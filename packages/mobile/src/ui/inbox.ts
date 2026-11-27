import type { MockupReviewScreen, ProjectRecord, SessionSummary, UpcomingMeeting } from '../api.js';
import { projectNoun } from '../changeSubmissions.js';
import { sessionAttention } from './attention.js';
import { mockupProgress } from './mockups.js';
import { projectNeedsRepair } from './projectBadge.js';
import { projectDisplayName } from './projectName.js';
import { qaIssueLabel, qaStopReason } from './qaRole.js';
import type { QAIssueDecision } from '../project-qa-api.js';
import { pullRequestMergeButton } from './pullRequest.js';
import {
  isSecuritySandboxUpdate,
  sandboxUpdateBlockedInboxMessage,
  sandboxUpdateNeedsAttention,
  sandboxUpdateSummary,
} from './sandboxUpdate.js';
import { sessionAgentWorking } from './sessionWork.js';
import { sessionLabel } from './sessionLabel.js';
import { permissionOverview } from './permissionOverview.js';
import type { PermissionLine } from './permissionSummary.js';

/**
 * Home's inbox: everything across all projects that needs the operator, each with
 * the answers that can be given in place.
 *
 * Pure and derived only from data the overview already holds (session summaries,
 * projects, upcoming meetings), so Home and the project list can never disagree
 * about a session: the rules are the same ones the list's markers use
 * ({@link sessionAttention}, {@link pullRequestMergeButton},
 * {@link projectNeedsRepair}, {@link sandboxUpdateNeedsAttention}). An item
 * disappears by itself once its source no longer reports it, which is what makes
 * an answered item leave Home.
 *
 * The operator can also dismiss an item that does not concern them right now
 * ({@link inboxView}). A dismissal is stored per person on the server against
 * the item's key, so it holds on all their devices; keys change with the facts
 * behind them, so a new question, a new commit or a new problem comes back.
 */

export type InboxItemKind =
  | 'meeting'
  | 'permission'
  | 'question'
  | 'plan_review'
  | 'mockup_review'
  | 'crashed'
  | 'merge_ready'
  | 'code_review'
  | 'project_health'
  | 'qa_stop';

/** What a tap on an item's answer does. The app maps each to an existing route. */
export type InboxAction =
  | { kind: 'allow'; label: string; sessionId: string; toolUseId: string }
  | { kind: 'deny'; label: string; sessionId: string; toolUseId: string }
  | { kind: 'answer'; label: string; sessionId: string; answer: string }
  | { kind: 'merge'; label: string; sessionId: string; number: number }
  | { kind: 'resume'; label: string; sessionId: string }
  | { kind: 'join_meeting'; label: string; eventKey: string }
  | { kind: 'skip_meeting'; label: string; eventKey: string }
  | { kind: 'repair_project'; label: string; projectId: string }
  | {
      kind: 'qa_decision';
      label: string;
      projectId: string;
      issueId: string;
      decision: QAIssueDecision;
    }
  | { kind: 'open_session'; label: string; sessionId: string }
  | { kind: 'review_mockups'; label: string; sessionId: string }
  | { kind: 'open_project'; label: string; projectId: string };

export interface InboxItem {
  /** Stable while the item means the same thing, so a list keeps its row and a
   * pending answer can be matched to it. */
  key: string;
  kind: InboxItemKind;
  /** Short uppercase tag text for the kind. */
  tag: string;
  tone: 'attention' | 'action' | 'success' | 'neutral';
  title: string;
  /** Where it comes from: project, session, time. */
  context: string;
  message?: string;
  /** Complete, short permission details, displayed without clipping next to Allow.
   *  Longer or incomplete requests use a preview in message and open the session. */
  lines?: PermissionLine[];
  sessionId?: string;
  projectId?: string;
  /** The screens of a mockup review, shown as thumbnails on the item. */
  mockups?: MockupReviewScreen[];
  /** Answers in display order; the first is the primary one. */
  actions: InboxAction[];
  /** Sort time in epoch ms (meetings: start; sessions: last activity). */
  at: number;
  /** Where dismissing it is stored: on its session or project, or — for a
   *  meeting — as the existing Skip decision. Absent when the server predates
   *  dismissing, so Home offers no X that could not be kept. */
  dismiss?: 'session' | 'project' | 'meeting';
}

/** Home's items split into what it shows and what the operator dismissed. */
export interface InboxView {
  visible: InboxItem[];
  hidden: InboxItem[];
}

export interface InboxInput {
  sessions: readonly SessionSummary[];
  projects: readonly ProjectRecord[];
  meetings?: readonly UpcomingMeeting[] | undefined;
  now: number;
}

/** How long before its start a meeting becomes something to decide. Matches the
 * server's join window, so a Join button is never offered before it works. */
export const MEETING_LEAD_MS = 15 * 60_000;

// Higher first. Meetings are time-bound; a parked permission blocks a running
// agent; a question, a plan or a mockup review blocks a finished turn; the rest can
// wait a moment.
const RANK: Record<InboxItemKind, number> = {
  meeting: 8,
  permission: 7,
  question: 6,
  qa_stop: 6,
  plan_review: 5,
  mockup_review: 4,
  crashed: 3,
  code_review: 2,
  merge_ready: 2,
  project_health: 1,
};

export function inboxItems(input: InboxInput): InboxItem[] {
  const projects = new Map(input.projects.map((project) => [project.id, project]));
  const items: InboxItem[] = [];
  for (const session of input.sessions) {
    const dismiss = session.inboxDismissed !== undefined ? ('session' as const) : undefined;
    for (const item of sessionItems(session, projects)) items.push(withDismiss(item, dismiss));
  }
  for (const meeting of input.meetings ?? []) {
    const item = meetingItem(meeting, input.now);
    if (item) items.push({ ...item, dismiss: 'meeting' });
  }
  for (const project of input.projects) {
    const item = projectHealthItem(project);
    const dismiss = project.inboxDismissed !== undefined ? ('project' as const) : undefined;
    if (item) items.push(withDismiss(item, dismiss));
    for (const stop of qaStopItems(project)) items.push(stop);
  }
  return items.sort((a, b) => {
    const rank = RANK[b.kind] - RANK[a.kind];
    if (rank !== 0) return rank;
    // Meetings soonest first; everything else newest first.
    return a.kind === 'meeting' ? a.at - b.at : b.at - a.at;
  });
}

function withDismiss(item: InboxItem, dismiss: InboxItem['dismiss']): InboxItem {
  return dismiss === undefined ? item : { ...item, dismiss };
}

/**
 * {@link inboxItems}, split by the operator's dismissals. Keys carry their
 * session or project id, so one set over every source cannot mix two items up.
 * Meetings never appear as hidden: skipping one is a decision, and decided
 * meetings leave the inbox altogether.
 */
export function inboxView(input: InboxInput): InboxView {
  const dismissed = inboxDismissedKeys(input);
  const view: InboxView = { visible: [], hidden: [] };
  for (const item of inboxItems(input))
    (dismissed.has(item.key) ? view.hidden : view.visible).push(item);
  return view;
}

/** Every Home item key the operator dismissed, across sessions and projects. */
export function inboxDismissedKeys(input: Pick<InboxInput, 'sessions' | 'projects'>): Set<string> {
  const dismissed = new Set<string>();
  for (const source of [...input.sessions, ...input.projects])
    for (const key of source.inboxDismissed ?? []) dismissed.add(key);
  return dismissed;
}

/** The words for Verity's line above the inbox, counted from the items. */
export function inboxSummary(items: readonly InboxItem[]): string {
  if (items.length === 0) return 'Nothing needs you right now.';
  const counts = new Map<InboxItemKind, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const parts: string[] = [];
  const add = (kind: InboxItemKind, one: string, many: string) => {
    const n = counts.get(kind);
    if (n) parts.push(n === 1 ? `1 ${one}` : `${n} ${many}`);
  };
  add('meeting', 'meeting soon', 'meetings soon');
  add('permission', 'permission', 'permissions');
  add('question', 'question', 'questions');
  add('qa_stop', 'QA decision', 'QA decisions');
  add('plan_review', 'plan to review', 'plans to review');
  add('mockup_review', 'mockup review', 'mockup reviews');
  add('crashed', 'crashed session', 'crashed sessions');
  add('code_review', 'code review', 'code reviews');
  add('merge_ready', 'pull request ready', 'pull requests ready');
  add('project_health', 'project needs care', 'projects need care');
  return parts.join(' · ');
}

/** "Also waiting: Merge ready": what else a session asks, named by its items' tags,
 *  so an overview can keep one entry per session without hiding the rest. */
export function alsoWaiting(items: readonly InboxItem[]): string {
  return `Also waiting: ${[...new Set(items.map((item) => item.tag))].join(', ')}`;
}

function sessionItems(
  session: SessionSummary,
  projects: ReadonlyMap<string, ProjectRecord>,
): InboxItem[] {
  const project = session.projectId ? projects.get(session.projectId) : undefined;
  if (project?.archived === true) return [];
  const label = sessionLabel(session);
  const where = project ? `${projectDisplayName(project)} · ${label}` : label;
  const at = session.lastActivityAt ?? 0;
  const base = {
    sessionId: session.sessionId,
    ...(session.projectId ? { projectId: session.projectId } : {}),
    at,
  };
  const open = (text = 'Open'): InboxAction => ({
    kind: 'open_session',
    label: text,
    sessionId: session.sessionId,
  });
  const items: InboxItem[] = [];

  // Permissions: one item per parked prompt the server could describe.
  // Requests belong to the person who asked (ADR 0023). The session still shows
  // and answers every one of them; Home lists only the requester's own.
  const mine = session.addressedToViewer !== false;
  const requests = session.pendingPermissionRequests ?? [];
  for (const request of requests) {
    if (request.addressedToViewer === false) continue;
    const { title, lines, message, decidable } = permissionOverview(request.tool, request.input);
    items.push({
      ...base,
      key: `permission:${session.sessionId}:${request.toolUseId}`,
      kind: 'permission',
      tag: 'Permission',
      tone: 'attention',
      title,
      context: where,
      ...(lines === undefined ? {} : { lines }),
      ...(message === undefined ? {} : { message }),
      actions: decidable
        ? [
            {
              kind: 'allow',
              // The session's card says the same: one call, nothing remembered.
              label: 'Allow once',
              sessionId: session.sessionId,
              toolUseId: request.toolUseId,
            },
            {
              kind: 'deny',
              label: 'Deny',
              sessionId: session.sessionId,
              toolUseId: request.toolUseId,
            },
            open(),
          ]
        : [open('Review')],
    });
  }
  // A prompt the server could not describe (older server, linked-session approval)
  // still needs the operator; send them to the card instead of hiding it.
  const described = new Set(requests.map((request) => request.toolUseId));
  // Unaddressed: the server cannot tell what it asks, so nor whom it is for.
  if (
    session.permissionAwaitingInput === true &&
    (session.pendingPermissions ?? []).some((id) => !described.has(id))
  ) {
    items.push({
      ...base,
      key: `permission:${session.sessionId}`,
      kind: 'permission',
      tag: 'Permission',
      tone: 'attention',
      title: 'Permission needed',
      context: where,
      actions: [open('Review')],
    });
  }

  const flags = sessionAttention({
    status: session.status,
    pr: session.pr,
    attention: session.attention,
  }).map((flag) => flag.kind);

  // Question: the turn's choices, or an awaiting session asking in prose.
  const choices = mine ? session.openChoices : undefined;
  if (choices !== undefined) {
    items.push({
      ...base,
      // Keyed by what is asked: later activity leaves an answered question hidden,
      // while a new question in a quick next turn gets a key of its own.
      key: `question:${session.sessionId}:${fingerprint([
        choices.question ?? '',
        ...choices.options.map((option) => option.label),
      ])}`,
      kind: 'question',
      tag: 'Question',
      tone: 'attention',
      title: choices.question ?? 'The session has a question',
      context: where,
      actions:
        choices.multiSelect === true
          ? [open('Answer')]
          : [
              ...choices.options.map((option): InboxAction => ({
                kind: 'answer',
                label: option.label,
                sessionId: session.sessionId,
                answer: option.label,
              })),
              open('Own answer'),
            ],
    });
  } else if (mine && flags.includes('question') && session.permissionAwaitingInput !== true) {
    items.push({
      ...base,
      key: `question:${session.sessionId}`,
      kind: 'question',
      tag: 'Question',
      tone: 'attention',
      title: 'Waiting for your answer',
      context: where,
      actions: [open('Answer')],
    });
  }

  // Plan: the agent presented a plan and waits for approval. Approving stays in
  // the session, where the plan can be read in full. The key follows the
  // revision, so a revised plan comes back after a dismissal.
  if (
    mine &&
    session.planning === 'active' &&
    session.planningPresented === true &&
    session.status !== 'running'
  ) {
    items.push({
      ...base,
      key: `plan:${session.sessionId}:${String(session.planningRevision ?? 0)}`,
      kind: 'plan_review',
      tag: 'Plan',
      tone: 'attention',
      title: 'Plan ready for review',
      context: where,
      message: 'Implementation waits for your approval.',
      actions: [open('Review plan')],
    });
  }

  // Mockups: open until the user tells the agent in the chat to build; marks alone
  // never end the review. While the agent works, the overview shows its activity.
  const review = session.mockupReview;
  if (
    mine &&
    !sessionAgentWorking(session) &&
    review?.state === 'pending' &&
    review.screens.length > 0
  ) {
    const undecided = review.screens.some((screen) => screen.verdict === 'open');
    items.push({
      ...base,
      // Each round asks anew: a dismissed round comes back once the agent revised it.
      key: `mockups:${session.sessionId}:${String(review.revision)}`,
      kind: 'mockup_review',
      tag: 'Mockups',
      tone: 'action',
      title: undecided ? 'Review mockups' : 'Mockups reviewed',
      context: `${where} · ${String(review.screens.length)} ${
        review.screens.length === 1 ? 'screen' : 'screens'
      }`,
      message: `${mockupProgress(review)}. Implementation starts when you say so in the chat.`,
      mockups: review.screens,
      actions: [
        { kind: 'review_mockups', label: 'Review', sessionId: session.sessionId },
        open('Open session'),
      ],
    });
  }

  if (flags.includes('crashed')) {
    items.push({
      ...base,
      // A crash after a resumed turn has grown the log, so it is not taken for
      // the one already answered with Resume.
      key: `crashed:${session.sessionId}:${String(session.eventCount ?? 0)}`,
      kind: 'crashed',
      tag: 'Crashed',
      tone: 'attention',
      title: label,
      context: project ? projectDisplayName(project) : 'Session',
      message: 'The session stopped during its turn.',
      actions:
        session.resumable === false
          ? [open()]
          : [{ kind: 'resume', label: 'Resume', sessionId: session.sessionId }, open()],
    });
  }

  // Submitted changes wait on everyone with Code until one of them writes in the
  // session; the server then addresses them to that person alone (ADR 0023).
  const submission = session.changeSubmission;
  // Once a pull request is open, its own item takes over from the review.
  if (
    submission?.addressedToViewer === true &&
    (submission.status === 'waiting' || submission.status === 'checking')
  ) {
    const who = submission.submittedBy.name ?? 'A member';
    items.push({
      ...base,
      // Each submission asks anew: a dismissed one returns when changes are resubmitted.
      key: `code_review:${session.sessionId}:${String(submission.submittedAt)}`,
      kind: 'code_review',
      tag: 'Code review',
      tone: 'action',
      title: `${who} submitted changes`,
      context: where,
      message:
        submission.checker === undefined
          ? `Check them and add them to ${projectNoun()}.`
          : `You are checking them.`,
      actions: [open('Review')],
    });
  }

  // Merge-ready only when the session's own merge button would offer Merge.
  const pr = session.pullRequest;
  if (flags.includes('merge_ready') && pr) {
    const button = pullRequestMergeButton(pr, { merging: false, mergeRejected: false });
    items.push({
      ...base,
      // The head commit is part of the key: a dismissed PR returns once it changes.
      key: `merge:${session.sessionId}:${pr.number}:${pr.headSha ?? ''}`,
      kind: 'merge_ready',
      tag: 'Merge ready',
      tone: 'success',
      title: pr.title,
      context: `${project ? projectDisplayName(project) : label} · PR #${pr.number}`,
      message:
        button.kind === 'merge'
          ? 'Checks passed, no conflicts.'
          : 'Ready, but you cannot merge it here.',
      actions:
        button.kind === 'merge'
          ? [
              {
                kind: 'merge',
                label: 'Merge',
                sessionId: session.sessionId,
                number: pr.number,
              },
              open(),
            ]
          : [open()],
    });
  }
  return items;
}

function meetingItem(meeting: UpcomingMeeting, now: number): InboxItem | undefined {
  // Decided meetings are the overlay's (joined) or nobody's (skipped, failed).
  if (meeting.decision !== null) return undefined;
  // In person needs a session to record into, which Home cannot pick for the
  // operator yet; those stay on the meeting screen's calendar list.
  if (meeting.provider === null) return undefined;
  if (meeting.endsAt <= now || meeting.startsAt - now > MEETING_LEAD_MS) return undefined;
  const minutes = Math.max(0, Math.round((meeting.startsAt - now) / 60_000));
  const when = minutes === 0 ? 'now' : `in ${minutes} min`;
  return {
    key: `meeting:${meeting.eventKey}`,
    kind: 'meeting',
    tag: 'Meeting',
    tone: 'neutral',
    title: meeting.title ?? 'Meeting',
    context: `${clockTime(meeting.startsAt)} · ${when} · ${meeting.calendar}`,
    message: 'Verity can join, transcribe and take notes.',
    actions: [
      { kind: 'join_meeting', label: 'Join with Verity', eventKey: meeting.eventKey },
      { kind: 'skip_meeting', label: 'Skip', eventKey: meeting.eventKey },
    ],
    at: meeting.startsAt,
  };
}

function projectHealthItem(project: ProjectRecord): InboxItem | undefined {
  if (project.archived === true) return undefined;
  const name = projectDisplayName(project);
  // Each key names the reason and the fact behind it, so a dismissed problem
  // returns when the project breaks again, a newer update stalls or the count of
  // severe findings changes — and not on unrelated lifecycle moves such as a
  // sandbox sleeping and waking.
  const key = (reason: string, fact: string) => `health:${project.id}:${reason}:${fact}`;
  const base = {
    kind: 'project_health' as const,
    tone: 'attention' as const,
    title: name,
    projectId: project.id,
    at: Date.parse(project.stateChangedAt ?? project.updatedAt) || 0,
  };
  const openProject: InboxAction = { kind: 'open_project', label: 'Open', projectId: project.id };
  // One item per project, the most pressing reason first.
  if (projectNeedsRepair(project)) {
    return {
      ...base,
      key: key('repair', project.stateChangedAt ?? ''),
      tag: 'Repair',
      context: 'Sandbox',
      message: project.provisionError ?? 'The project sandbox needs a repair.',
      actions: [{ kind: 'repair_project', label: 'Repair', projectId: project.id }, openProject],
    };
  }
  if (sandboxUpdateNeedsAttention(project.sandboxUpdate)) {
    const update = project.sandboxUpdate;
    return {
      ...base,
      key:
        update.recovery?.state === 'failed'
          ? key('update-recovery', `${update.recovery.state}:${update.recovery.at}`)
          : key('update', update.targetRevision ?? update.targetVersion ?? update.target ?? ''),
      tag: isSecuritySandboxUpdate(update) ? 'Security update' : 'Update',
      context: 'Sandbox',
      message:
        update.recovery?.state === 'failed'
          ? sandboxUpdateSummary(update)!
          : update.turnBlocked
            ? sandboxUpdateBlockedInboxMessage(update)
            : 'The sandbox could not update itself.',
      actions: [openProject],
    };
  }
  const vulnerabilities = project.vulnerabilitySummary;
  const severe = (vulnerabilities?.critical ?? 0) + (vulnerabilities?.high ?? 0);
  if (vulnerabilities && severe > 0) {
    return {
      ...base,
      key: key('vulnerabilities', String(severe)),
      tag: 'Vulnerabilities',
      context: 'Security',
      message:
        severe === 1
          ? '1 critical or high vulnerability.'
          : `${severe} critical or high vulnerabilities.`,
      actions: [openProject],
    };
  }
  return undefined;
}

/**
 * Where a project's QA stopped and waits for the user, one item per issue,
 * answered in place. Never dismissable: QA stays stopped until someone decides.
 */
function qaStopItems(project: ProjectRecord): InboxItem[] {
  const qa = project.qaSummary;
  if (project.archived === true || !qa || qa.mode === 'off' || qa.mode === 'paused') return [];
  const name = projectDisplayName(project);
  return qa.stopped.map((issue) => {
    const answer = (label: string, decision: QAIssueDecision): InboxAction => ({
      kind: 'qa_decision',
      label,
      projectId: project.id,
      issueId: issue.id,
      decision,
    });
    return {
      key: `qa:${project.id}:${issue.id}:${issue.updatedAt}`,
      kind: 'qa_stop' as const,
      tag: 'Needs you',
      tone: 'attention' as const,
      title: `Repair stopped: ${qaIssueLabel(issue.key)}`,
      context: `QA · ${name}`,
      message: issue.detail
        ? `${qaStopReason(issue.reason)} ${issue.detail}`
        : qaStopReason(issue.reason),
      projectId: project.id,
      actions: [
        answer('Another round', 'another_round'),
        answer('Take over', 'take_over'),
        answer('Defer', 'defer'),
      ],
      at: Date.parse(issue.updatedAt) || 0,
    };
  });
}

function clockTime(epochMs: number): string {
  const date = new Date(epochMs);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** A short, stable digest of a question's text and options (djb2). */
function fingerprint(parts: readonly string[]): string {
  let hash = 5381;
  for (const char of parts.join('\u0000')) {
    hash = ((hash << 5) + hash + (char.codePointAt(0) ?? 0)) | 0;
  }
  return (hash >>> 0).toString(36);
}
