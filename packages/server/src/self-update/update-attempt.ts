import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DockerError } from '../docker.js';
import type { UpdatePhase } from './update-journal.js';
import type { UpdateOperation } from './update-operation.js';
import { isTerminalOperationState } from './update-operation.js';

/**
 * What the Updater remembers about the last failed attempt at the current
 * operation, so a device can see WHY an update stopped moving.
 *
 * Deliberately a sidecar next to the journal and not a journal field: the
 * journal and its projection are parsed with exact key sets, and a cutover runs
 * two Server generations (and, across a companion handoff, two Updater
 * generations) against the same record. Widening either would make the older
 * side reject the record it has to keep reading. An Updater that predates this
 * file ignores it; one that finds it unreadable answers "nothing recorded".
 *
 * The error is a closed `{ phase, cause }` pair. Docker messages carry registry
 * hosts, container ids and paths; none of that may become device-visible text.
 */

export const UPDATE_ATTEMPT_FILE = 'update-attempt.json';

/**
 * How long an operation may sit in one non-terminal phase before it is stuck.
 *
 * Every non-terminal state advances on its own — `prepared` is not an operator
 * gate; the runner goes straight from `standby` into the cutover. So any
 * non-terminal state that stops moving is a stall, and the only question is how
 * long is too long. 30 minutes is far above the slowest legitimate step (an
 * image pull on a slow link) and far below the hours an incident can run
 * unseen. The attention banner, the Server's recovery offer and the Updater's
 * supersede rule all read this one value, so the banner never says "stuck"
 * while the update screen refuses to act on it.
 */
export const UPDATER_STALL_MS = 30 * 60 * 1000;

/** True when a non-terminal operation has not changed phase for {@link UPDATER_STALL_MS}. */
export function isStalledOperation(
  operation: Pick<UpdateOperation, 'state' | 'updatedAt'>,
  now: number,
): boolean {
  if (isTerminalOperationState(operation.state)) return false;
  const updatedAt = Date.parse(operation.updatedAt);
  // An unparsable timestamp is not evidence of a stall; the journal is the
  // Updater's own record and a malformed value is a different bug.
  if (Number.isNaN(updatedAt)) return false;
  return now - updatedAt > UPDATER_STALL_MS;
}

export const UPDATE_ATTEMPT_CAUSES = [
  'network-timeout',
  'network',
  'registry',
  'disk-full',
  'unhealthy',
  'docker',
  'unknown',
] as const;

export type UpdateAttemptCause = (typeof UPDATE_ATTEMPT_CAUSES)[number];

/**
 * Phases a stalled operation may be abandoned in by a newer request — the
 * Updater's rule, which the Server mirrors when it decides what to offer.
 *
 * Only the companion step: the Server already runs the stuck operation's
 * target, and the one thing left undone is moving the companions onto that
 * image — which the successor's own companion step does for its newer image
 * anyway. `committed` is excluded although it is post-commit too: the runner
 * leaves it for the companion step under the same lease, so an operation still
 * there stopped mid-transition, and the sealed spec may not name its target
 * yet. Before commit the live Server, the candidate and the Gateway are
 * mid-switch, and abandoning that would leave a topology no step owns.
 *
 * The trade-off: if the successor then fails or rolls back, nothing retries the
 * abandoned companion step on its own any more. The deployment is left where
 * the stuck operation already had it — Server on the committed image,
 * companions partly behind — and the next successful update moves them. That
 * is no worse than the stall it replaces, which was not moving them either.
 */
export const SUPERSEDABLE_PHASES: readonly UpdatePhase[] = ['reconciling-companions'];

/** The update ids journals carry; shared by every hop that accepts one. */
export const UPDATE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/;

export interface UpdateAttempt {
  readonly updateId: string;
  /** Failed attempts at this operation since it began; reset only by a new one. */
  readonly failures: number;
  readonly lastAttemptAt: string;
  readonly lastError: { readonly phase: UpdatePhase; readonly cause: UpdateAttemptCause } | null;
}

const PATTERNS: readonly (readonly [RegExp, UpdateAttemptCause])[] = [
  [/i\/o timeout|timed out|timeout exceeded|deadline exceeded|ETIMEDOUT/i, 'network-timeout'],
  [/no space left on device|ENOSPC/i, 'disk-full'],
  [
    /unauthorized|denied|toomanyrequests|manifest unknown|pull access|authentication required/i,
    'registry',
  ],
  [
    /dial tcp|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|connection reset|no such host|network is unreachable|TLS handshake/i,
    'network',
  ],
  [/unhealthy|exited during startup|did not become healthy/i, 'unhealthy'],
];

function messages(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  // Docker wraps transport failures in `cause`; the timeout is usually there.
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    parts.push(
      current instanceof Error
        ? current.message
        : typeof current === 'string'
          ? current
          : JSON.stringify(current),
    );
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join('\n');
}

/** Reduce an attempt failure to a closed cause; the message itself never leaves. */
export function classifyUpdateError(error: unknown): UpdateAttemptCause {
  const text = messages(error);
  for (const [pattern, cause] of PATTERNS) if (pattern.test(text)) return cause;
  if (error instanceof DockerError) return error.kind === 'network' ? 'network' : 'docker';
  return 'unknown';
}

const PHASES: readonly UpdatePhase[] = [
  'requested',
  'pulling',
  'verifying-image',
  'preflight',
  'creating-standby',
  'standby',
  'quiescing-old',
  'handing-off-key',
  'activating-candidate',
  'checking-candidate',
  'draining-gateway',
  'switching-gateway',
  'observing-candidate',
  'committed',
  'reconciling-companions',
  'completed',
  'rollback-quiescing-candidate',
  'rollback-activating-old',
  'rollback-switching-gateway',
  'rolled-back',
  'failed',
];

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

const timestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

/** Strict parser shared by the file, the Updater route and the Server client. */
export function parseUpdateAttempt(value: unknown): UpdateAttempt | null {
  if (!plain(value) || !exact(value, ['updateId', 'failures', 'lastAttemptAt', 'lastError']))
    return null;
  if (
    typeof value.updateId !== 'string' ||
    !UPDATE_ID_PATTERN.test(value.updateId) ||
    !Number.isSafeInteger(value.failures) ||
    (value.failures as number) < 0 ||
    !timestamp(value.lastAttemptAt)
  )
    return null;
  let lastError: UpdateAttempt['lastError'];
  if (value.lastError === null) lastError = null;
  else if (
    plain(value.lastError) &&
    exact(value.lastError, ['phase', 'cause']) &&
    PHASES.includes(value.lastError.phase as UpdatePhase) &&
    (UPDATE_ATTEMPT_CAUSES as readonly unknown[]).includes(value.lastError.cause)
  )
    lastError = {
      phase: value.lastError.phase as UpdatePhase,
      cause: value.lastError.cause as UpdateAttemptCause,
    };
  else return null;
  return {
    updateId: value.updateId,
    failures: value.failures as number,
    lastAttemptAt: value.lastAttemptAt,
    lastError,
  };
}

/**
 * Read the record, or `null` when there is none or it cannot be trusted.
 *
 * This is diagnostics, not intent: nothing executes from it. A missing, foreign
 * or corrupt file therefore reads as "nothing recorded" instead of failing the
 * status route that reports it.
 */
export async function readUpdateAttempt(root: string): Promise<UpdateAttempt | null> {
  try {
    const file = await open(
      join(await realpath(root), UPDATE_ATTEMPT_FILE),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.uid !== process.geteuid?.() || metadata.size > 4096)
        return null;
      return parseUpdateAttempt(JSON.parse(await file.readFile('utf8')));
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

/** Replace the record atomically; private to the Updater like the journal. */
export async function writeUpdateAttempt(root: string, attempt: UpdateAttempt): Promise<void> {
  if (parseUpdateAttempt(attempt) === null) throw new Error('update attempt record is invalid');
  const directory = await realpath(root);
  const temporary = join(directory, `.update-attempt-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(attempt)}\n`, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, join(directory, UPDATE_ATTEMPT_FILE));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function clearUpdateAttempt(root: string): Promise<void> {
  try {
    await unlink(join(await realpath(root), UPDATE_ATTEMPT_FILE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
