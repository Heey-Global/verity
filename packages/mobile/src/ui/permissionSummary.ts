import { END_PLANNING_TOOL, planningToolName } from '@verity/events';

import { spellOutBidiControls } from './bidi.js';
import {
  brokeredAuthSentence,
  brokeredHttpSummary,
  brokeredHttpTitle,
} from './brokeredHttpSummary.js';
import { calendarChangeSummary } from './calendarChangeSummary.js';
import { gmailSendSummary } from './gmailSendSummary.js';
import {
  KNOWLEDGE_PUBLISH_EXPLANATION,
  knowledgePublishSummary,
} from './knowledgePublishSummary.js';
import { matrixSendSummary } from './matrixSendSummary.js';
import { packageInstallSummary } from './packageInstallSummary.js';
import { schedulingApprovalSummary } from './schedulingSummary.js';
import {
  listSessionsSummary,
  listSessionsTitle,
  recentSessionMessagesSummary,
  sessionHandoffSummary,
  sessionHandoffTitle,
  sessionProgressSummary,
} from './sessionHandoffSummary.js';
import { toolCallPrimaryField, toolCallView } from './toolCall.js';
import {
  trustedCliInjectionSummary,
  trustedCliSecretLabel,
  trustedCliSummary,
  type TrustedCliSummary,
} from './trustedCliSummary.js';

/** One line under a permission's title: `code` is what runs or is sent, verbatim. */
export interface PermissionLine {
  kind: 'code' | 'text';
  text: string;
}

export interface PermissionSummary {
  title: string;
  /** What a reader needs to decide without opening the session. Empty when the
   *  tool has no summariser, or when its summariser could not read the input. */
  lines: PermissionLine[];
  /** Whether {@link lines} carry everything the input asks, so an overview may
   *  fold the raw input. False when a field the lines leave out could matter. */
  covered: boolean;
}

/** Fields that only describe or pace a call, never change what it does. */
const COMMENTARY_FIELDS: ReadonlySet<string> = new Set([
  'description',
  'timeout',
  'run_in_background',
]);

function linkedMessage(input: unknown): { target: string; message: string } | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const fields = input as Record<string, unknown>;
  return typeof fields.targetSessionId === 'string' && typeof fields.message === 'string'
    ? { target: fields.targetSessionId, message: fields.message }
    : null;
}

/** Trusted CLI: the command in the order it runs. Tokens are arbitrary strings
 *  and this card hands a secret to a process, so bidi controls are spelled out. */
export function trustedCliCommandLine(summary: TrustedCliSummary): string {
  return spellOutBidiControls(summary.command.map((token) => JSON.stringify(token)).join(' '));
}

/** Trusted CLI: which secrets go where, and what the process can then do with them. */
export function trustedCliRiskSentence(summary: TrustedCliSummary): string {
  const entry =
    summary.entryScript !== null
      ? `Entry script ${summary.entryScript.path} (SHA-256 ${summary.entryScript.sha256}, ${summary.entryScript.loading} loading). `
      : '';
  const reach = summary.secrets.length === 1 ? 'the complete secret' : 'every one of them in full';
  return `${entry}Verity injects ${trustedCliInjectionSummary(summary)}. This trusted process can read, transform, or disclose ${reach}. Output redaction is hygiene only and cannot prevent exfiltration.`;
}

/**
 * What a parked permission asks, in words: the title the session's approval card
 * shows, and the lines Home shows under it.
 *
 * The session card and Home both take their title from here, so the same request
 * never reads one way in the inbox and another in the session. Every summariser
 * already exists for the session card; this only puts them in one order. A tool
 * none of them recognises is titled by name, and its raw input stays the thing
 * to read.
 */
export function permissionSummary(
  tool: string,
  input: unknown,
  options: { approvedForDelivery?: boolean } = {},
): PermissionSummary {
  // Every field below is written by the agent: session ids, recipients, paths,
  // secret and variable names. Spelled out here once, so no title or line can
  // reorder what the operator reads next to Allow, whichever branch made it.
  const summary = summarize(tool, input, options);
  return {
    title: spellOutBidiControls(summary.title),
    lines: summary.lines.map((line) => ({ ...line, text: spellOutBidiControls(line.text) })),
    // A tool's own summariser words its whole request; without lines nothing does.
    covered: summary.covered ?? summary.lines.length > 0,
  };
}

function summarize(
  tool: string,
  input: unknown,
  options: { approvedForDelivery?: boolean },
): Omit<PermissionSummary, 'covered'> & { covered?: boolean } {
  const packageInstall = tool === 'verity_package_install' ? packageInstallSummary(input) : null;
  if (packageInstall !== null)
    return {
      title: packageInstall.title,
      lines: [
        { kind: 'code', text: spellOutBidiControls(packageInstall.command) },
        { kind: 'text', text: spellOutBidiControls(packageInstall.explanation) },
      ],
    };
  if (tool === 'verity_knowledge') {
    const knowledge = knowledgePublishSummary(input);
    return {
      title: knowledge?.replacesExisting
        ? 'Save changes to Global Knowledge?'
        : 'Publish insight to Global Knowledge?',
      lines:
        knowledge === null
          ? []
          : [
              { kind: 'text', text: `Source: ${knowledge.source}` },
              { kind: 'text', text: `Destination: ${knowledge.destination}` },
              { kind: 'text', text: KNOWLEDGE_PUBLISH_EXPLANATION },
            ],
    };
  }
  const http = tool === 'verity_http_request' ? brokeredHttpSummary(input) : null;
  if (http !== null)
    return {
      title: brokeredHttpTitle(http),
      lines: [
        { kind: 'code', text: `${http.method} ${http.host}${http.path}` },
        ...(http.body !== null
          ? [{ kind: 'code' as const, text: spellOutBidiControls(http.body) }]
          : []),
        { kind: 'text', text: brokeredAuthSentence(http) },
      ],
    };
  const cli = tool === 'verity_secret_run' ? trustedCliSummary(input) : null;
  if (cli !== null)
    return {
      title: `Run trusted command with ${trustedCliSecretLabel(cli)}?`,
      lines: [
        { kind: 'code', text: trustedCliCommandLine(cli) },
        { kind: 'text', text: trustedCliRiskSentence(cli) },
      ],
    };
  const handoff = tool === 'verity_session_handoff' ? sessionHandoffSummary(input) : null;
  // The briefing and the message are what approving turns into another session's
  // prompt, so they are the lines to read, in full.
  if (handoff !== null)
    return {
      title: sessionHandoffTitle(handoff),
      lines: [
        { kind: 'text', text: `To ${handoff.target}` },
        { kind: 'text', text: handoff.title },
        { kind: 'text', text: handoff.briefing },
      ],
    };
  const linked = tool === 'verity_send_session_message' ? linkedMessage(input) : null;
  if (linked !== null)
    return {
      title: options.approvedForDelivery
        ? `Retry delivery to ${linked.target}?`
        : `Send to ${linked.target} and continue the exchange?`,
      lines: [{ kind: 'text', text: linked.message }],
    };
  const listing = tool === 'verity_list_sessions' ? listSessionsSummary(input) : null;
  if (listing !== null) return { title: listSessionsTitle(listing), lines: [] };
  const progress = tool === 'verity_session_progress' ? sessionProgressSummary(input) : null;
  if (progress !== null)
    return { title: `Read progress for session ${progress.sessionId}?`, lines: [] };
  const recent =
    tool === 'verity_recent_session_messages' ? recentSessionMessagesSummary(input) : null;
  if (recent !== null)
    return {
      title: `Read ${String(recent.count)} recent messages from session ${recent.sessionId}?`,
      lines: [],
    };
  const calendar = tool === 'verity_google_calendar' ? calendarChangeSummary(input) : null;
  if (calendar !== null) return { title: calendar.title, lines: [] };
  const scheduling = tool === 'verity_scheduling' ? schedulingApprovalSummary(input) : null;
  if (scheduling !== null) return { title: spellOutBidiControls(scheduling.title), lines: [] };
  const matrix = tool === 'verity_matrix' ? matrixSendSummary(input) : null;
  if (matrix !== null)
    return {
      title: `Send Matrix message to ${spellOutBidiControls(matrix.roomName)}?`,
      lines: [{ kind: 'text', text: spellOutBidiControls(matrix.body) }],
    };
  const gmail = tool === 'verity_gmail' ? gmailSendSummary(input) : null;
  if (gmail !== null)
    return {
      title: `Send email to ${gmail.to.join(', ')}?`,
      lines: [{ kind: 'text', text: `Subject: ${spellOutBidiControls(gmail.subject)}` }],
    };
  const planning = planningToolName(tool);
  if (planning === END_PLANNING_TOOL) {
    const action =
      typeof input === 'object' && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>).action
        : undefined;
    return {
      title: action === 'discard' ? 'Leave planning and change files?' : 'Implement the plan?',
      lines: [],
    };
  }
  if (planning === 'verity_present_plan') return { title: 'Show the proposed plan?', lines: [] };
  const view = toolCallView({
    name: tool,
    input,
    state: 'running',
    createdAt: 0,
    startedAt: null,
    completedAt: null,
    description: null,
  });
  // Spelled out like every other string on the card. Tool names are
  // server-controlled today, so this is consistency rather than exposure.
  // The field the call is about (a command, a path, an address), whole, so an
  // overview can show it instead of the raw input.
  const primary = toolCallPrimaryField(tool, input);
  return {
    title: `Allow ${spellOutBidiControls(view.title)}?`,
    lines: primary !== null ? [{ kind: 'code', text: primary.text }] : [],
    // Covered only when every other field merely describes the call (Bash's
    // description); the content of a Write or an unknown field stays in view.
    covered:
      primary !== null &&
      Object.keys(input as Record<string, unknown>).every(
        (key) => key === primary.field || COMMENTARY_FIELDS.has(key),
      ),
  };
}
