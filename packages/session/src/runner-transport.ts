import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { PermissionRequest } from '@verity/adapter-claude';
import type { AgentEvent } from '@verity/events';
import { RUNNER_FRAME_PROTOCOL_VERSION } from '@verity/store';
import type { RunResult } from './backend-contract.js';

/**
 * The Runner → Server EVENT transport (ADR 0006 D1). The in-Sandbox Runner writes
 * its whole turn stream to an append-only JSONL file on the bind-mount
 * (`/work/.verity-sessions/<id>/events.jsonl`); the Server tails it, persists each
 * event to the DB, and fans it out to the bus (D2 — the Server persists, the
 * Runner touches no DB). The file's append is the durability point: an event is
 * durable on the mount BEFORE the Server ever reads it, and it survives a Server
 * or Runner restart mid-turn.
 *
 * Tailing is byte-offset polling (like {@link syncTranscript}), NOT `fs.watch` —
 * `fs.watch` is unreliable on the container's bind-mount / overlay filesystems.
 *
 * This is the Stage 2.1 slice: the transport is proven as a STANDALONE,
 * roundtrip-tested module. It is not wired into any live dispatch path here; the
 * control channel (steer/cancel/answerPermission) stays in-process (a later
 * slice's control socket).
 */

const LF = 0x0a;

/**
 * The body of one event-stream line: the discriminated union whose `kind` tag
 * distinguishes the four frame types the Runner emits over a turn's lifetime. The
 * body is what the {@link RunnerFrameEnvelope}'s `payloadHash` is computed over.
 */
export type RunnerFrameBody =
  | { kind: 'session'; id: string }
  | { kind: 'event'; event: AgentEvent }
  | { kind: 'permission-request'; request: PermissionRequest }
  | { kind: 'result'; result: RunResult };

/**
 * The restart-safe framing envelope (ADR 0006 D3) carried on every line ALONGSIDE
 * the body. `frameSeq` starts at 1 and is contiguous within a turn; `turnId` binds
 * immutably to one `runnerInstanceId`; `payloadHash` fingerprints the body. The
 * Server treats `payloadHash` as an opaque token — it stores it on first claim and,
 * if the same `(turnId, frameSeq)` is replayed with a DIFFERENT stored hash, flags
 * corruption; it does not re-derive the hash from the body. These let the Server
 * ingest a re-tailed file from byte zero idempotently (D4).
 */
export interface RunnerFrameEnvelope {
  protocolVersion: number;
  runnerInstanceId: string;
  turnId: string;
  frameSeq: number;
  payloadHash: string;
}

/**
 * One line of the event stream file: the {@link RunnerFrameEnvelope} merged with a
 * {@link RunnerFrameBody}, serialized as a single JSON object per line (JSONL). Flat
 * (envelope fields beside the body's `kind`) so existing readers keep using
 * `frame.kind` / `frame.event` unchanged while gaining the sequencing metadata.
 */
export type RunnerFrame = RunnerFrameEnvelope & RunnerFrameBody;

/** The canonical payload fingerprint the Server stores and compares on replay (it
 * never recomputes this, so the algorithm lives solely here). SHA-256 over the JSON
 * of the body — deterministic because each body is built with a fixed key order. */
export function frameBodyHash(body: RunnerFrameBody): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

/**
 * Stamp a body with a fresh envelope: the caller-owned `turnId` + `runnerInstanceId`
 * and the next contiguous `frameSeq`. Kept beside the hash so a single writer mints
 * envelopes consistently. The flat spread keeps `frame.kind` and the body fields at
 * the top level.
 */
export function stampFrame(
  body: RunnerFrameBody,
  meta: { turnId: string; runnerInstanceId: string; frameSeq: number },
): RunnerFrame {
  return {
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    runnerInstanceId: meta.runnerInstanceId,
    turnId: meta.turnId,
    frameSeq: meta.frameSeq,
    payloadHash: frameBodyHash(body),
    ...body,
  };
}

/** A place frames can be appended to: either an open {@link FileHandle} or a path
 * that {@link writeFrame} opens in append mode for each write. */
export type FrameSink = FileHandle | { path: string };

function isFileHandle(handle: FrameSink): handle is FileHandle {
  return typeof (handle as FileHandle).appendFile === 'function';
}

/**
 * Append ONE frame to the stream file as a single JSON line terminated by `\n`
 * (JSONL). Serializing per-line keeps the file tailable: a reader splits on `\n`
 * and parses each complete line independently, so a partially-written trailing
 * line is simply not yet a complete frame.
 *
 * Accepts either a held-open {@link FileHandle} (the {@link RunnerServer} keeps one
 * per turn and closes it after the terminal `result`) or `{ path }` (each call
 * opens+appends+closes — convenient for tests / one-off writes).
 */
export async function writeFrame(handle: FrameSink, frame: RunnerFrame): Promise<void> {
  const line = `${JSON.stringify(frame)}\n`;
  if (isFileHandle(handle)) {
    await handle.appendFile(line, 'utf8');
    return;
  }
  const fh = await open(handle.path, 'a');
  try {
    await fh.appendFile(line, 'utf8');
  } finally {
    await fh.close();
  }
}

/** Cursor into the tailed file: byte offset + an incomplete trailing byte run
 * carried across polls (mirrors {@link TailState} in transcript-sync). */
interface FrameTailState {
  offset: number;
  pending: Buffer;
}

/** Parse one complete JSONL line into a {@link RunnerFrame}. Throws on invalid
 * JSON, a line whose `kind` is not one of the four known frame tags, or a missing/
 * malformed sequencing envelope — the tail treats a malformed frame as a hard error
 * rather than silently dropping a turn's event (the append side is the ONLY writer
 * of this file). */
function parseFrame(line: string): RunnerFrame {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== 'object' || parsed === null || !('kind' in parsed)) {
    throw new Error(`invalid runner frame (no kind): ${line}`);
  }
  const kind: unknown = parsed.kind;
  if (
    kind !== 'session' &&
    kind !== 'event' &&
    kind !== 'permission-request' &&
    kind !== 'result'
  ) {
    throw new Error(`invalid runner frame kind: ${JSON.stringify(kind)}`);
  }
  const f = parsed as Record<string, unknown>;
  if (
    typeof f.protocolVersion !== 'number' ||
    typeof f.runnerInstanceId !== 'string' ||
    typeof f.turnId !== 'string' ||
    typeof f.frameSeq !== 'number' ||
    typeof f.payloadHash !== 'string'
  ) {
    throw new Error(`invalid runner frame envelope: ${line}`);
  }
  return parsed as RunnerFrame;
}

/** Read the bytes appended since `fromOffset` (mirrors transcript-sync's
 * `readAppended`). Advances by the actual `bytesRead`, so a short read resumes
 * next tick. The event file is append-only, so no shrink/reset path is needed. */
async function readAppended(
  filePath: string,
  fromOffset: number,
): Promise<{ chunk: Buffer; offset: number }> {
  const { size } = await stat(filePath);
  if (size <= fromOffset) return { chunk: Buffer.alloc(0), offset: fromOffset };
  const fd = await open(filePath, 'r');
  try {
    const length = size - fromOffset;
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fd.read(buf, 0, length, fromOffset);
    return { chunk: buf.subarray(0, bytesRead), offset: fromOffset + bytesRead };
  } finally {
    await fd.close();
  }
}

/**
 * One tail tick: read newly-appended bytes, invoke `onFrame` for each COMPLETE
 * line in order, and carry the trailing incomplete bytes to the next tick.
 * Splitting on the LF byte (never part of a multi-byte UTF-8 char) means each
 * parsed line is a complete byte sequence. Returns the advanced state plus whether
 * a `result` frame was seen (which terminates the tail). `onFrame` is awaited so
 * frames are delivered strictly in order even when the consumer is async.
 */
async function tailOnce(
  filePath: string,
  state: FrameTailState,
  onFrame: (frame: RunnerFrame) => void | Promise<void>,
): Promise<{ state: FrameTailState; sawResult: boolean }> {
  const { chunk, offset } = await readAppended(filePath, state.offset);
  const data = Buffer.concat([state.pending, chunk]);
  let start = 0;
  let sawResult = false;
  let nl = data.indexOf(LF, start);
  while (nl !== -1) {
    const line = data.subarray(start, nl).toString('utf8');
    start = nl + 1;
    if (line.trim() !== '') {
      const frame = parseFrame(line);
      await onFrame(frame);
      if (frame.kind === 'result') {
        // The result is terminal (last frame of the turn). Stop here — anything the
        // file holds after it is not part of this turn and must not be delivered.
        sawResult = true;
        break;
      }
    }
    nl = data.indexOf(LF, start);
  }
  return { state: { offset, pending: data.subarray(start) }, sawResult };
}

/**
 * Byte-offset-poll the event stream file, invoking `onFrame` for each complete
 * frame IN ORDER, until a `result` frame is seen or `signal` aborts. Partial
 * trailing lines are buffered across polls (a frame split by a poll boundary is
 * carried, as bytes, to the next tick). Resolves once the terminal `result` frame
 * has been delivered; rejects if the signal aborts before then, or a frame fails
 * to parse.
 *
 * NOT `fs.watch` — byte-offset polling is the reliable idiom on the container's
 * bind-mount / overlay filesystems (same rationale as `syncTranscript`).
 */
export async function tailFrames(
  filePath: string,
  onFrame: (frame: RunnerFrame) => void | Promise<void>,
  opts: { pollMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const pollMs = opts.pollMs ?? 20;
  let state: FrameTailState = { offset: 0, pending: Buffer.alloc(0) };
  for (;;) {
    if (opts.signal?.aborted) throw abortError();
    let existed = true;
    try {
      const tick = await tailOnce(filePath, state, onFrame);
      state = tick.state;
      if (tick.sawResult) return;
    } catch (err) {
      if (isEnoent(err)) {
        // The writer may not have created the file yet on the first poll(s);
        // keep polling until it appears rather than failing the tail.
        existed = false;
      } else {
        throw err;
      }
    }
    await delay(existed ? pollMs : Math.min(pollMs, 5), opts.signal);
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

function abortError(): Error {
  const err = new Error('tailFrames aborted');
  err.name = 'AbortError';
  return err;
}

/** Sleep `ms`, rejecting immediately if `signal` aborts during the wait. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
