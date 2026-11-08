import { sandboxNotReadyError } from '@verity/events';

/**
 * Turn-start readiness of a project Sandbox's agent connections.
 *
 * A woken or recreated Sandbox is admitted once Docker reports its relay
 * container running, which happens before the relay process listens. A turn
 * started in that window reaches the local egress connector, which then has its
 * forward to the relay refused: the agent reports a 502 for Codex, and the
 * `verity` MCP server (served through the relay's broker port) fails to start.
 *
 * The probe runs inside the Sandbox and only opens TCP connections, so repeating
 * it while the relay starts sends no request, performs no TLS handshake and costs
 * no model call. Nothing here retries the turn itself: the gate runs before the
 * agent is launched, so a timeout leaves the operator's message unsent.
 */

export const EGRESS_HOPS = ['connector', 'claude', 'codex', 'broker'] as const;
export type EgressHop = (typeof EGRESS_HOPS)[number];

const HOP_STATES = [
  'ready',
  'refused',
  'unresolved',
  'timeout',
  'unreachable',
  'invalid',
  'not_configured',
] as const;
export type EgressHopState = (typeof HOP_STATES)[number];

export type SandboxEgressReadiness = Record<EgressHop, EgressHopState>;

export type SandboxEgressProbe =
  /** The Sandbox's toolkit predates the probe; the turn proceeds as before. */
  | { kind: 'unsupported' }
  /** The supervisor did not answer; the Sandbox may still be starting. */
  | { kind: 'unavailable' }
  | { kind: 'readiness'; readiness: SandboxEgressReadiness };

export type TurnAgent = 'claude' | 'codex' | 'opencode';

/** The hops a turn of this agent cannot start without. OpenCode reaches its
 *  provider through the Codex leg (`/opencode` on the connector).
 *
 *  The gateway legs are waited on only behind a project relay, where a refusal
 *  is the relay still starting. Without one they point straight at the gateway,
 *  which opens its Codex listener only once a credential exists: a refusal there
 *  can be permanent, and the turn should meet it at once as it always did. */
export function requiredEgressHops(
  agent: TurnAgent,
  options: { relayed?: boolean } = {},
): readonly EgressHop[] {
  if (options.relayed === false) return ['connector', 'broker'];
  return agent === 'claude' ? ['connector', 'claude', 'broker'] : ['connector', 'codex', 'broker'];
}

/** Parse a supervisor `egress-readiness` reply. Anything malformed reads as an
 *  older toolkit rather than as a failure: the gate must never block a turn on a
 *  reply shape it does not understand. */
export function parseEgressReadiness(reply: Record<string, unknown>): SandboxEgressProbe {
  if (reply.egressReadinessVersion !== 1) return { kind: 'unsupported' };
  const readiness = {} as SandboxEgressReadiness;
  for (const hop of EGRESS_HOPS) {
    const state = reply[hop];
    if (typeof state !== 'string' || !(HOP_STATES as readonly string[]).includes(state))
      return { kind: 'unsupported' };
    readiness[hop] = state as EgressHopState;
  }
  return { kind: 'readiness', readiness };
}

/**
 * Read a failed supervisor request. Only a timeout is a Sandbox that may still
 * be coming up: the supervisor is there and did not answer in time. Anything
 * else — no socket, a refused or denied connect, an older toolkit's refusal of
 * the request, a malformed reply — says nothing about the agent connections, so
 * the turn proceeds exactly as it did before this gate existed and meets the
 * same failure it always would, rather than stalling first.
 */
// A missing or refusing supervisor socket is read as `unsupported` rather than
// waited on because turns are admitted only after the Runner stack reported
// ready (`beforeRunnerAdmission` on wake and recreate); a socket absent at that
// point is not a start-up race this gate could outwait.
export function classifyProbeError(error: unknown): SandboxEgressProbe {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  return code === 'ETIMEDOUT' ? { kind: 'unavailable' } : { kind: 'unsupported' };
}

/** Hops still in the way. `not_configured` and `invalid` are not waited on:
 *  they come from the Sandbox's own environment, which no amount of waiting
 *  changes, and the forward reports them as it always did. */
export function pendingEgressHops(
  probe: SandboxEgressProbe,
  required: readonly EgressHop[],
): readonly EgressHop[] | 'supervisor' {
  if (probe.kind === 'unavailable') return 'supervisor';
  if (probe.kind === 'unsupported') return [];
  return required.filter((hop) => {
    const state = probe.readiness[hop];
    return state !== 'ready' && state !== 'not_configured' && state !== 'invalid';
  });
}

export const TURN_READINESS_TIMEOUT_MS = 90_000;
export const TURN_READINESS_DELAYS_MS: readonly number[] = [250, 500, 1_000, 2_000];

/** The transcript note while the turn waits; its first sentence is the headline. */
export const TURN_READINESS_WAITING_MESSAGE =
  'Preparing project environment. Checking the agent connection and tools. Your message continues automatically when they’re ready.';

export interface TurnReadinessLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface TurnReadinessInput {
  projectId: string;
  sessionId: string;
  agent: TurnAgent;
  /** Whether the gateway legs run through a project relay; see {@link requiredEgressHops}. */
  relayed?: boolean;
  probe: () => Promise<SandboxEgressProbe>;
  canWait: boolean;
  waitingOn: (message: string) => void;
  log: TurnReadinessLog;
  timeoutMs?: number;
  delaysMs?: readonly number[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type TurnReadinessOutcome =
  { outcome: 'ready'; attempts: number; durationMs: number } | { outcome: 'unsupported' };

/**
 * Wait, with bounded backoff inside one overall deadline, until the hops the
 * turn needs accept connections. Resolves at once on the hot path (one probe).
 * A background resolution (`canWait` false) never waits: it fails fast with the
 * transient Sandbox class, as every other not-ready state does.
 */
export async function waitForSandboxTurnReadiness(
  input: TurnReadinessInput,
): Promise<TurnReadinessOutcome> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = input.timeoutMs ?? TURN_READINESS_TIMEOUT_MS;
  const delays = input.delaysMs ?? TURN_READINESS_DELAYS_MS;
  const required = requiredEgressHops(
    input.agent,
    input.relayed === undefined ? {} : { relayed: input.relayed },
  );
  const startedAt = now();
  const context = { projectId: input.projectId, sessionId: input.sessionId, agent: input.agent };
  let attempts = 0;
  let last: SandboxEgressProbe;
  let pending: readonly EgressHop[] | 'supervisor';
  for (;;) {
    attempts += 1;
    last = await input.probe();
    if (last.kind === 'unsupported') return { outcome: 'unsupported' };
    pending = pendingEgressHops(last, required);
    const durationMs = Math.max(0, now() - startedAt);
    if (pending !== 'supervisor' && pending.length === 0) {
      if (attempts > 1)
        input.log.info(
          { ...context, attempts, durationMs },
          'verity: project Sandbox agent connections became ready',
        );
      return { outcome: 'ready', attempts, durationMs };
    }
    if (!input.canWait) {
      throw sandboxNotReadyError(
        `project Sandbox agent connections are not ready yet (${describeStates(last, pending)})`,
      );
    }
    if (attempts === 1) {
      input.log.info(
        { ...context, pending, states: statesOf(last) },
        'verity: waiting for project Sandbox agent connections before starting the turn',
      );
      input.waitingOn(TURN_READINESS_WAITING_MESSAGE);
    }
    const delay = delays[Math.min(attempts - 1, delays.length - 1)] ?? 1_000;
    if (durationMs + delay > timeoutMs) break;
    await sleep(delay);
  }
  const durationMs = Math.max(0, now() - startedAt);
  input.log.warn(
    { ...context, attempts, durationMs, pending, states: statesOf(last) },
    'verity: project Sandbox agent connections did not become ready; turn not started',
  );
  throw sandboxNotReadyError(timeoutMessage(input.agent, pending, last, timeoutMs, attempts));
}

const HOP_NAMES: Record<EgressHop, string> = {
  connector: 'its local agent connection',
  claude: 'its connection to Claude',
  codex: 'its connection to Codex',
  broker: 'the Verity tools connection',
};

/**
 * The operator-facing text. The first line is one plain sentence naming what
 * was not ready and that nothing ran; the app shows it as the explanation and
 * keeps the lines after it behind "Details".
 */
export function timeoutMessage(
  agent: TurnAgent,
  pending: readonly EgressHop[] | 'supervisor',
  last: SandboxEgressProbe,
  timeoutMs: number,
  attempts: number,
): string {
  const seconds = Math.round(timeoutMs / 1000);
  const subject =
    pending === 'supervisor'
      ? `The project environment didn’t answer within ${String(seconds)} seconds.`
      : `The project environment started, but ${joinNames(pending.map((hop) => HOP_NAMES[hop]))} ${pending.length === 1 ? 'wasn’t' : 'weren’t'} ready within ${String(seconds)} seconds.`;
  return [
    `${subject} Your message wasn’t sent to the agent.`,
    'startup_readiness_timeout',
    `agent: ${agent}; attempts: ${String(attempts)}`,
    describeStates(last, pending),
  ].join('\n');
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
}

function statesOf(probe: SandboxEgressProbe): Record<string, string> | string {
  return probe.kind === 'readiness' ? { ...probe.readiness } : probe.kind;
}

function describeStates(
  probe: SandboxEgressProbe,
  pending: readonly EgressHop[] | 'supervisor',
): string {
  if (pending === 'supervisor' || probe.kind !== 'readiness') return 'runner supervisor: no answer';
  return EGRESS_HOPS.map((hop) => `${hop}: ${probe.readiness[hop]}`).join('; ');
}
