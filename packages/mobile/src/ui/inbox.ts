import type { ProjectRecord, SessionSummary, UpcomingMeeting } from '../api.js';
import { sessionAttention } from './attention.js';
import { projectNeedsRepair } from './projectBadge.js';
import { projectDisplayName } from './projectName.js';
import { pullRequestMergeButton } from './pullRequest.js';
import { sandboxUpdateNeedsAttention, isSecuritySandboxUpdate } from './sandboxUpdate.js';
import { sessionLabel } from './sessionLabel.js';
import { toolCallView } from './toolCall.js';

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
 */

export type InboxItemKind =
  'meeting' | 'permission' | 'question' | 'crashed' | 'merge_ready' | 'project_health';

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
  | { kind: 'open_session'; label: string; sessionId: string }
  | { kind: 'open_project'; label: string; projectId: string };

export interface InboxItem {
  /** Stable while the item means the same thing, so a list keeps its row and a
   * pending answer can be matched to it. */
  key: string;
  kind: InboxItemKind;
  /** Short uppercase tag text for the kind. */
  tag: string;
  tone: 'attention' | 'success' | 'neutral';
  title: string;
  /** Where it comes from: project, session, time. */
  context: string;
  message?: string;
  sessionId?: string;
  projectId?: string;
  /** Answers in display order; the first is the primary one. */
  actions: InboxAction[];
  /** Sort time in epoch ms (meetings: start; sessions: last activity). */
  at: number;
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
// agent; a question blocks a finished turn; the rest can wait a moment.
const RANK: Record<InboxItemKind, number> = {
  meeting: 6,
  permission: 5,
  question: 4,
  crashed: 3,
  merge_ready: 2,
  project_health: 1,
};

/** Tools whose card carries a decision the generic Allow would lose. */
const OPEN_TO_DECIDE: ReadonlySet<string> = new Set(['verity_package_install']);

export function inboxItems(input: InboxInput): InboxItem[] {
  const projects = new Map(input.projects.map((project) => [project.id, project]));
  const items: InboxItem[] = [];
  for (const session of input.sessions) items.push(...sessionItems(session, projects));
  for (const meeting of input.meetings ?? []) {
    const item = meetingItem(meeting, input.now);
    if (item) items.push(item);
  }
  for (const project of input.projects) {
    const item = projectHealthItem(project);
    if (item) items.push(item);
  }
  return items.sort((a, b) => {
    const rank = RANK[b.kind] - RANK[a.kind];
    if (rank !== 0) return rank;
    // Meetings soonest first; everything else newest first.
    return a.kind === 'meeting' ? a.at - b.at : b.at - a.at;
  });
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
  add('crashed', 'crashed session', 'crashed sessions');
  add('merge_ready', 'pull request ready', 'pull requests ready');
  add('project_health', 'project needs care', 'projects need care');
  return parts.join(' · ');
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
  const requests = session.pendingPermissionRequests ?? [];
  for (const request of requests) {
    const view = toolCallView({
      name: request.tool,
      input: request.input,
      state: 'running',
      createdAt: 0,
      startedAt: null,
      completedAt: null,
      description: null,
    });
    const decidable = request.input !== undefined && !OPEN_TO_DECIDE.has(request.tool);
    items.push({
      ...base,
      key: `permission:${session.sessionId}:${request.toolUseId}`,
      kind: 'permission',
      tag: 'Permission',
      tone: 'attention',
      title: view.headline,
      context: where,
      ...(view.subtitle ? { message: view.subtitle } : {}),
      actions: decidable
        ? [
            {
              kind: 'allow',
              label: 'Allow',
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
  const choices = session.openChoices;
  if (choices !== undefined) {
    items.push({
      ...base,
      key: `question:${session.sessionId}`,
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
  } else if (flags.includes('question') && session.permissionAwaitingInput !== true) {
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

  if (flags.includes('crashed')) {
    items.push({
      ...base,
      key: `crashed:${session.sessionId}`,
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

  // Merge-ready only when the session's own merge button would offer Merge.
  const pr = session.pullRequest;
  if (flags.includes('merge_ready') && pr) {
    const button = pullRequestMergeButton(pr, { merging: false, mergeRejected: false });
    items.push({
      ...base,
      key: `merge:${session.sessionId}:${pr.number}`,
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
                label: 'Squash & merge',
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
  const base = {
    key: `health:${project.id}`,
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
      tag: isSecuritySandboxUpdate(update) ? 'Security update' : 'Update',
      context: 'Sandbox',
      message: update.turnBlocked
        ? 'A sandbox update waits for the running turn to finish.'
        : 'The sandbox could not update itself.',
      actions: [openProject],
    };
  }
  const vulnerabilities = project.vulnerabilitySummary;
  const severe = (vulnerabilities?.critical ?? 0) + (vulnerabilities?.high ?? 0);
  if (vulnerabilities && severe > 0) {
    return {
      ...base,
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

function clockTime(epochMs: number): string {
  const date = new Date(epochMs);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
