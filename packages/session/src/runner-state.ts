import { chmod, open, rename, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { RUNNER_FRAME_PROTOCOL_VERSION } from '@verity/store';

/**
 * The per-turn Runner status file (ADR 0006 D3). Written beside a turn's append-only
 * event file, it is a small, atomically-replaced pointer that ASSISTS discovery — it
 * lets the Server find in-flight turns and read their identity/liveness without
 * scanning the whole event log. It is NOT the event authority: the append-only frame
 * log remains the source of truth, so `lastFrameSeq` is a hint (a re-tail from byte
 * zero is always safe and idempotent — D4), not a correctness boundary.
 *
 * Genuine reattach (discovering these files at startup, re-tailing, and re-binding
 * control) lands in a later slice; this establishes the durable status artifact.
 */

export type RunnerTurnStatus = 'running' | 'settled';

export interface RunnerTurnState {
  /** The frame protocol version this turn's stream uses (ADR 0006 D3). */
  protocolVersion: number;
  /** Server-allocated turn id — the discovery key. */
  turnId: string;
  /** The runner process instance that owns the turn; immutable per `turnId`. */
  runnerInstanceId: string;
  /** The session the turn runs for; null until the backend binds its session. */
  sessionId: string | null;
  /** `running` while the turn is live; `settled` once it is no longer live. A NORMAL
   * settle marks `settled` only after the terminal `result` frame is on disk; an
   * ABNORMAL settle (the run rejected before producing a result) also marks `settled` —
   * so discovery doesn't see the turn forever live — but writes NO terminal frame. The
   * append-only frame log stays authoritative, so a consumer must not read `settled` as
   * "a terminal frame exists"; it confirms the real disposition from the log. */
  status: RunnerTurnStatus;
  /** The highest frame sequence written so far — a discovery hint, not authority. */
  lastFrameSeq: number;
  /** Epoch ms when the run started / this record was last replaced / it settled. */
  startedAt: number;
  updatedAt: number;
  settledAt: number | null;
  /** Whether the settled turn ended via cancel/abort (null while running). */
  aborted: boolean | null;
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

/**
 * Atomically replace the state file: write a uniquely-named temp sibling, then
 * `rename` it over the target. `rename` within a directory is atomic, so a
 * concurrent {@link readRunnerState} observes either the old or the new record —
 * never a half-written one. The temp name carries a random suffix so overlapping
 * writers never collide on the same temp path.
 */
export async function writeRunnerState(path: string, state: RunnerTurnState): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(state), 'utf8');
  await chmod(tmp, 0o640);
  const file = await open(tmp, 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(tmp, path);
  // Persist the directory entry replacement too. Without this fsync, a power loss
  // after rename may resurrect the previous state or lose the file altogether.
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  // NOTE: a crash BETWEEN the write and the rename leaves an orphan `*.tmp` sibling.
  // It never corrupts a read (`readRunnerState` opens only the exact state path), but a
  // later runtime-dir sweep / discovery scan should ignore the `*.tmp` suffix.
}

/** Read and validate a state file. Returns `undefined` when the file is absent or
 * its content is not a well-formed {@link RunnerTurnState} (a partially-written or
 * corrupt file is treated as "no usable state", never as a hard error — discovery
 * must tolerate a Runner that died mid-write). */
export async function readRunnerState(path: string): Promise<RunnerTurnState | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return isRunnerTurnState(parsed) ? parsed : undefined;
}

function isRunnerTurnState(v: unknown): v is RunnerTurnState {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.protocolVersion === 'number' &&
    typeof s.turnId === 'string' &&
    typeof s.runnerInstanceId === 'string' &&
    (typeof s.sessionId === 'string' || s.sessionId === null) &&
    (s.status === 'running' || s.status === 'settled') &&
    typeof s.lastFrameSeq === 'number' &&
    typeof s.startedAt === 'number' &&
    typeof s.updatedAt === 'number' &&
    (typeof s.settledAt === 'number' || s.settledAt === null) &&
    (typeof s.aborted === 'boolean' || s.aborted === null)
  );
}

/** Build the initial `running` state for a freshly-started turn. */
export function initialRunnerTurnState(
  turnId: string,
  runnerInstanceId: string,
  now: number,
): RunnerTurnState {
  return {
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    turnId,
    runnerInstanceId,
    sessionId: null,
    status: 'running',
    lastFrameSeq: 0,
    startedAt: now,
    updatedAt: now,
    settledAt: null,
    aborted: null,
  };
}
