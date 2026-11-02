import { CLAUDE_EGRESS_PLACEHOLDER } from './claude-egress-policy.js';

export interface ClaudeEgressAgentEnvOptions {
  /** True to route the agent's Claude traffic through the sandbox-local connector
   *  → egress gateway. Must be true ONLY when the connector is actually running in
   *  the target sandbox (otherwise the agent points `ANTHROPIC_BASE_URL` at a
   *  closed port). */
  routed: boolean;
  /** Loopback port the sandbox connector listens on. Required for the routed path. */
  connectorPort: number | undefined;
}

export function claudeEgressRelayGeneration(
  inspect: {
    running: boolean;
    labels?: Readonly<Record<string, string>> | undefined;
  },
  generationLabelName: string,
): string | undefined {
  const generation = inspect.labels?.[generationLabelName];
  return inspect.running && generation !== undefined && generation !== '' ? generation : undefined;
}

export async function claudeEgressRelayHealthy(
  inspect: {
    running: boolean;
    labels?: Readonly<Record<string, string>> | undefined;
  },
  generationLabelName: string,
  isGenerationHealthy: (containerGeneration: string) => Promise<boolean>,
): Promise<boolean> {
  const containerGeneration = claudeEgressRelayGeneration(inspect, generationLabelName);
  return (
    containerGeneration !== undefined && (await isGenerationHealthy(containerGeneration)) === true
  );
}

export function claudeEgressRouteEnabled(options: {
  isClaudeSession: boolean;
  egressActive: boolean;
}): boolean {
  return options.isClaudeSession && options.egressActive;
}

/**
 * Refuse a Claude turn that did not resolve the ACP transport, naming the
 * transport it did resolve.
 *
 * ACP is the only Claude transport (ADR 0012) and the gateway is the only holder
 * of the credential (ADR 0010 Phase 2), so every downstream branch may assume a
 * Claude turn is an ACP turn: none fetches an access token, and no agent process
 * receives `CLAUDE_CODE_OAUTH_TOKEN` beyond the non-secret placeholder. A Claude
 * session arriving on another transport has lost that boundary rather than merely
 * picked a different protocol — hence a refusal instead of a fallback.
 *
 * Returns the operator-facing message, or undefined when the turn may proceed.
 */
export function claudeTransportRefusal(options: {
  isClaudeSession: boolean;
  runnerSupervisorBackend: string | undefined;
}): string | undefined {
  if (!options.isClaudeSession || options.runnerSupervisorBackend === 'claude-acp') {
    return undefined;
  }
  return `Claude turns require the ACP transport, but this session resolved '${options.runnerSupervisorBackend ?? 'none'}'.`;
}

/**
 * Refuse a Claude PROJECT turn in a deployment whose gateway egress is not
 * configured.
 *
 * Such a deployment cannot serve the turn at all: the agent would authenticate
 * with nothing and fail as an opaque upstream 401. Control-plane turns need no
 * equivalent check — they require `controlPlaneRunner`, which the server refuses
 * to start without complete egress identity wiring.
 *
 * Returns the operator-facing message, or undefined when the turn may proceed.
 */
export function claudeProjectEgressRefusal(options: {
  isClaudeSession: boolean;
  egressActive: boolean;
}): string | undefined {
  if (!options.isClaudeSession || options.egressActive) return undefined;
  return 'Claude turns require the agent gateway egress. Configure the Claude egress identity and connector port before sending another message.';
}

/** Why a turn-time repair of a Sandbox without a valid Agent Gateway identity
 *  did not make it ready. `undefined` means no repair was attempted or the repair
 *  declined without an error to report. */
export type AgentGatewayRepairFailure =
  | { stage: 'rebuild'; cause: unknown }
  | { stage: 'verify'; cause: unknown }
  | { stage: 'still_unready' };

const REPAIR_REASON_MAX_CHARS = 300;

function repairReason(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const firstLine = raw.split('\n', 1)[0]?.trim() ?? '';
  const reason = firstLine === '' ? 'unknown error' : firstLine;
  return reason.length > REPAIR_REASON_MAX_CHARS
    ? `${reason.slice(0, REPAIR_REASON_MAX_CHARS)}…`
    : reason;
}

/**
 * The operator-facing message for a Claude/Codex/OpenCode turn refused because its
 * Sandbox has no valid Agent Gateway identity.
 *
 * When the automatic repair failed for a reason of its own — build storage
 * unavailable, an image that would not build — that reason is what the operator
 * has to act on, so it is named rather than hidden behind the identity symptom.
 */
export function agentGatewayUnavailableMessage(failure?: AgentGatewayRepairFailure): string {
  const prefix = 'Sandbox has no valid Agent Gateway identity';
  switch (failure?.stage) {
    case 'rebuild':
      return `${prefix}, and the automatic Sandbox rebuild failed: ${repairReason(failure.cause)} — resolve that, then send the message again`;
    case 'verify':
      return `${prefix}, and the rebuilt Sandbox could not be verified: ${repairReason(failure.cause)} — repair the project, then send the message again`;
    case 'still_unready':
      return `${prefix}, and it was still missing after the automatic Sandbox rebuild — repair the project, then send the message again`;
    case undefined:
      return `${prefix} and could not be repaired automatically — repair the project, then send the message again`;
  }
}

/**
 * Decide the Claude-related environment a PROJECT agent process receives.
 *
 * The routing cutover (ADR 0006 D10): when `routed`, the agent talks to the
 * sandbox-local connector (`ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`) and holds
 * only the non-secret {@link CLAUDE_EGRESS_PLACEHOLDER} — the real OAuth token
 * never enters the untrusted sandbox; the egress gateway injects it server-side.
 *
 * There is no unrouted Claude alternative left to fall back to (ADR 0010 Phase 2):
 * the empty result is for a NON-Claude session, whose agent must not be handed
 * Claude environment at all. A Claude session with inactive egress is refused by
 * {@link claudeProjectEgressRefusal} before it reaches here, so `routed: false`
 * never means "run Claude on a directly injected token" — that consumer is gone.
 *
 * Pure and side-effect-free so the branch is unit-tested; the caller (embedded.ts
 * sessionBackend) merges the result into the container env.
 */
export function claudeEgressAgentEnv(options: ClaudeEgressAgentEnvOptions): Record<string, string> {
  if (!options.routed) return {};
  if (options.connectorPort === undefined) {
    throw new Error('Claude egress routing requires a connector port');
  }
  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${String(options.connectorPort)}`,
    CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_EGRESS_PLACEHOLDER,
  };
}
