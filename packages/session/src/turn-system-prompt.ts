import type { PermissionDecision } from '@verity/adapter-claude';
import {
  AGENT_LOOP_PROPOSAL_SYSTEM_PROMPT,
  AUTONOMY_RESUME_SYSTEM_PROMPT,
  AUTONOMY_SYSTEM_PROMPT,
  BREVITY_SYSTEM_PROMPT,
  CHOICES_SYSTEM_PROMPT,
  CODE_REVIEW_SYSTEM_PROMPT,
  DELEGATION_SYSTEM_PROMPT,
  LANGUAGE_SYSTEM_PROMPT,
  LOCAL_PROJECT_SYSTEM_PROMPT,
  MEMORY_SYSTEM_PROMPT,
  PULL_REQUEST_SYSTEM_PROMPT,
  REPO_CONVENTIONS_SYSTEM_PROMPT,
  SANDBOX_RESOURCES_SYSTEM_PROMPT,
  TERMINOLOGY_SYSTEM_PROMPT,
  VISIBLE_MEDIA_SYSTEM_PROMPT,
} from '@verity/events';
import type { SessionRecord } from '@verity/store';

import type { Backend } from './backend.js';

/**
 * Runtime directives appended when a backend context is initialized: the
 * outcome-ownership and Quick-Action `choices` contracts (#97), the sub-agent
 * delegation nudge that keeps bulky reads out of the re-sent main context (#138),
 * durable project-memory guidance, the review-ready (never draft) pull-request
 * rule, the branch and Conventional-Commit conventions whose only feedback is a
 * missing Issue chip or a wrong SemVer bump, the pre-push code review contract
 * that names `verity-code-review run` rather than leaving the agent holding the
 * marker command alone, the English-artifacts rule that keeps commits and PRs out
 * of the chat language, the sandbox resource limits a turn must not spend past,
 * and the brevity nudge that stops the parent from pasting long sub-agent
 * reports back verbatim as the operator-facing reply.
 *
 * Resumed turns rely on the existing backend context
 * instead of re-sending the same policy text on every operator message. Not all
 * of it: {@link RESUME_SYSTEM_PROMPT} is the deliberate exception list, and each
 * entry is there for its own reason. Do not trim it on the strength of this
 * sentence.
 *
 * A project created without a GitHub repository gets {@link
 * LOCAL_PROJECT_SYSTEM_PROMPT} in place of the pull-request rule rather than
 * alongside it. There the remote-bound directive is not merely inert: paired
 * with the Quick-Action contract's `Push + PR` example it is what makes the
 * agent offer push/PR chips, and those labels are rendered verbatim, so a tap
 * dispatches a turn that cannot succeed against a clone with no `origin`.
 *
 * {@link REPO_CONVENTIONS_SYSTEM_PROMPT} and {@link CODE_REVIEW_SYSTEM_PROMPT}
 * are NOT part of that swap. Neither is remote-bound the way the pull-request
 * rule is: a local project still branches and commits, and its clone can be
 * linked to GitHub later — the case {@link LOCAL_PROJECT_SYSTEM_PROMPT} names
 * its own expiry condition for. Dropping them there would leave the session that
 * outlives the link naming branches the Issue chip cannot parse.
 */
function assembleTurnSystemPrompt(localProject: boolean): string {
  return `${TERMINOLOGY_SYSTEM_PROMPT}

${AUTONOMY_SYSTEM_PROMPT}

${CHOICES_SYSTEM_PROMPT}

${DELEGATION_SYSTEM_PROMPT}

${MEMORY_SYSTEM_PROMPT}

${VISIBLE_MEDIA_SYSTEM_PROMPT}

${localProject ? LOCAL_PROJECT_SYSTEM_PROMPT : PULL_REQUEST_SYSTEM_PROMPT}

${REPO_CONVENTIONS_SYSTEM_PROMPT}

${CODE_REVIEW_SYSTEM_PROMPT}

${LANGUAGE_SYSTEM_PROMPT}

${SANDBOX_RESOURCES_SYSTEM_PROMPT}

${BREVITY_SYSTEM_PROMPT}`;
}

const TURN_SYSTEM_PROMPT = assembleTurnSystemPrompt(false);
const LOCAL_PROJECT_TURN_SYSTEM_PROMPT = assembleTurnSystemPrompt(true);

/**
 * The compact subset resumed turns still receive. {@link
 * SANDBOX_RESOURCES_SYSTEM_PROMPT} is in it although the rest of the heavy
 * policy is not — and not merely to migrate contexts that predate the rule. A
 * long-lived context is compacted repeatedly, so what it still carries late in
 * its life is what gets re-sent per turn. This one earns that place because its
 * failure mode is the only one here that lands on someone else: an over-large
 * heap cap gets the largest process in the cgroup killed, which is as likely to
 * be a neighbouring session's test run as the turn that set the flag. A rule
 * whose violation ends another session has to keep reaching the contexts that
 * are already running. The compact autonomy directive also converges existing
 * contexts onto the current outcome and Quick-Action semantics without paying
 * the full fresh-context contracts on every turn.
 */
export const RESUME_SYSTEM_PROMPT = `${TERMINOLOGY_SYSTEM_PROMPT}

${AUTONOMY_RESUME_SYSTEM_PROMPT}

${VISIBLE_MEDIA_SYSTEM_PROMPT}

${SANDBOX_RESOURCES_SYSTEM_PROMPT}`;

export function turnSystemPrompt(
  kind: SessionRecord['kind'] | undefined,
  localProject = false,
): string {
  const base = localProject ? LOCAL_PROJECT_TURN_SYSTEM_PROMPT : TURN_SYSTEM_PROMPT;
  return kind === 'agent_loop' ? `${base}\n\n${AGENT_LOOP_PROPOSAL_SYSTEM_PROMPT}` : base;
}

const MAX_PROMPT_SECRET_ALIASES = 100;
const MAX_PROMPT_SECRET_ALIAS_BYTES = 8 * 1024;

/** Denial handed to an out-of-band caller that gave up waiting (deadline, disconnect).
 *  It reaches the agent as the tool's rejection reason, so it says what to do next. */
export const EXTERNAL_PERMISSION_ABORT_MESSAGE =
  'The approval request expired before it was answered. Ask again if you still need this.';

/** Whether a permission was answered on a card the operator saw, or by a standing grant
 *  redeemed without one. */
export type PermissionDecisionSource = 'card' | 'grant';

/** What {@link Conductor.requestExternalPermission} resolves with: the decision, plus how
 *  it was reached — a caller writing an audit record must not claim a card was shown when
 *  a grant answered silently (ADR 0014 D3). */
export interface ExternalPermissionAnswer {
  decision: PermissionDecision;
  decidedBy: PermissionDecisionSource;
}

export function formatBrokeredSecretAliases(secretAliases?: readonly string[]): string {
  if (secretAliases === undefined || secretAliases.length === 0) return '';
  const included: string[] = [];
  let bytes = 0;
  for (const alias of secretAliases) {
    const addedBytes = Buffer.byteLength(`${included.length === 0 ? '' : ', '}${alias}`, 'utf8');
    if (
      included.length >= MAX_PROMPT_SECRET_ALIASES ||
      bytes + addedBytes > MAX_PROMPT_SECRET_ALIAS_BYTES
    ) {
      break;
    }
    included.push(alias);
    bytes += addedBytes;
  }
  const omitted = secretAliases.length - included.length;
  // "Only these names", not "only one name": a trusted CLI run carries up to
  // MAX_TRUSTED_CLI_SECRETS of them and a JWT request resolves a claim source
  // per alias, so a one-alias reading would send the agent back to packing
  // several credentials into a single Doppler value.
  return `\n\nSecret names available in this project: ${included.join(', ')}${omitted > 0 ? ` (${omitted} more omitted)` : ''}. Every \`secretAlias\` must be one of the listed names; a call may reference more than one of them, but never guess a name that is not listed.`;
}

/**
 * Whether this backend has any channel that can carry the brokered secret tools: the
 * loopback MCP gateway whose per-turn bearer is minted for the ACP transports
 * (ADR 0014, `RunnerSupervisorClient`).
 *
 * A backend that declares no transport has neither: it runs on the loopback path with
 * no permission bridging, so no brokered prompt can be raised for it at all (see
 * {@link brokeredGrantChannel}). Telling such a session which secret names exist
 * would hand it a list and no sanctioned way to spend it, which is the same dead end as
 * telling it nothing, only more inviting. No backend Verity ships is in that state
 * since OpenCode moved to `opencode-acp` — the `undefined` arm now guards the
 * dropped-field case `brokeredGrantChannel` describes, plus whatever a future
 * loopback-only backend turns out to be.
 *
 * `opencode-acp` is the case that shows why this is not simply "is it supervised".
 * OpenCode runs behind the same spawn broker as Claude and Codex since ADR 0012
 * Amendment 4, and its adapter even advertises `mcpCapabilities.http` — so it COULD
 * carry the gateway. It does not, because which agents may spend the operator's
 * secrets is a decision, not a consequence of the transport they happen to use. It is
 * absent from `ACP_WORKER_BACKENDS`, no bearer is minted for its turns, and so the
 * honest answer here is `false`: naming the secrets to a session that has no way to
 * redeem them is the dead end described above.
 *
 * Written as an exhaustive switch rather than a presence check for the same reason
 * {@link brokeredGrantChannel} is: the two answers must move together, and a presence
 * check fails OPEN — a protocol added to `RunnerSupervisorBackend` later would
 * start receiving names before anyone decided it can spend them. Here a new member
 * fails the build instead, and a value that bypasses the types (a cast, a process
 * boundary) is read as "no channel".
 */
export function carriesBrokeredSecretTools(backend: Backend): boolean {
  switch (backend.runnerSupervisorBackend) {
    case 'claude-acp':
    case 'codex-acp':
      return true;
    case 'opencode-acp':
    case undefined:
      return false;
    default:
      return assertNoBrokeredToolChannel(backend.runnerSupervisorBackend);
  }
}

/** Compile-time exhaustiveness for {@link carriesBrokeredSecretTools}, failing closed
 *  at runtime if the types are ever bypassed. */
function assertNoBrokeredToolChannel(backend: never): boolean {
  void backend;
  return false;
}

/**
 * Append the brokered-secret context this backend still needs, on top of whatever the
 * turn already assembled.
 *
 * The NAMES go to every transport that can reach the tools. Secret names are not secret
 * (ADR 0011 D3), and a session that cannot see them can only guess — which is
 * indistinguishable from the secret not existing, and is what sends an agent looking for
 * Doppler credentials instead of reporting that it lacks a name.
 *
 * The RULES for using the tools arrive through the MCP tool
 * descriptions served next to the schemas (`BROKERED_HTTP_TOOL_DESCRIPTION` /
 * `TRUSTED_CLI_TOOL_DESCRIPTION`), so repeating them here would ship a second copy of
 * the same security rules — paid for in every turn, and free to drift from the copy
 * the agent actually reads beside the tool it is calling.
 */
export function withBackendSystemPrompt(
  prompt: string | undefined,
  backend: Backend,
  secretAliases?: readonly string[],
): string {
  const base = prompt ?? '';
  if (!carriesBrokeredSecretTools(backend)) return base;
  const names = formatBrokeredSecretAliases(secretAliases);
  return `${base}${names}`;
}
