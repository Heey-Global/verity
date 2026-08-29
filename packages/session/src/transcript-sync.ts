import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdir, open, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TranscriptStore } from '@verity/store';

/**
 * Capture claude's on-disk `.jsonl` transcript verbatim into the durable
 * {@link TranscriptStore}, and restore it back to disk for `--resume` after a
 * container rebuild (concept §5a). Investigated against real files (Claude Code
 * 2.1.220):
 *   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 * where the cwd is encoded by replacing every character outside `[A-Za-z0-9]`
 * with `-` (verified by running the CLI from `/tmp/Pr_Obe.X/Sub-Dir9`, which
 * produced `-tmp-Pr-Obe-X-Sub-Dir9`). The file is append-only NDJSON,
 * LF-delimited, each line (including the last) terminated.
 *
 * Tailing is done at the BYTE level (split on 0x0a, decode whole lines only) so
 * a multi-byte UTF-8 sequence split across a poll boundary is never corrupted —
 * an incomplete trailing byte sequence is carried, as bytes, to the next tick.
 */

const LF = 0x0a;
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Encode an absolute cwd into its `~/.claude/projects` folder name: every
 * character outside `[A-Za-z0-9]` becomes `-`. Note this collapses `.` too —
 * `/work/.verity-sessions/agent-1a2b` lands in `-work--verity-sessions-agent-1a2b`,
 * NOT `-work-.verity-sessions-agent-1a2b`. Since every session worktree lives
 * under a dot-directory, a `/`-only encoding misses every transcript there is.
 */
export function encodeCwd(cwd: string): string {
  return cwd.replaceAll(/[^a-zA-Z0-9]/g, '-');
}

/**
 * The directory claude files every conversation under, relative to its home. Exported
 * because the server's artifact sweep walks that directory rather than resolving one
 * path through {@link transcriptPath}, and a sweep that looked in the wrong place would
 * either delete nothing or — worse, once it also names the sessions it may collect —
 * delete from somewhere claude never wrote.
 */
export const CLAUDE_PROJECTS_DIRNAME = 'projects';

function assertValidSessionId(sessionId: string): void {
  // Session ids are claude-generated UUIDs; guard before it reaches a file path.
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`invalid session id for path construction: ${JSON.stringify(sessionId)}`);
  }
}

/** Resolve the transcript path for a session. `claudeHome` defaults to `~/.claude`. */
export function transcriptPath(opts: {
  cwd: string;
  sessionId: string;
  claudeHome?: string | undefined;
}): string {
  assertValidSessionId(opts.sessionId);
  const home = opts.claudeHome ?? join(homedir(), '.claude');
  return join(home, CLAUDE_PROJECTS_DIRNAME, encodeCwd(opts.cwd), `${opts.sessionId}.jsonl`);
}

/** Cursor into the tailed file: byte offset + an incomplete trailing byte run. */
export interface TailState {
  offset: number;
  pending: Buffer;
}

export const initialTailState: TailState = { offset: 0, pending: Buffer.alloc(0) };

/**
 * Read the bytes appended since `fromOffset`. If the file shrank (a rewrite /
 * `/compact` / reset) the read restarts from 0 — the returned `offset` is then
 * LESS than `fromOffset`, signalling the caller to drop any pending bytes. The
 * offset advances by the actual `bytesRead`, so a short read just resumes next
 * tick.
 */
export async function readAppended(
  filePath: string,
  fromOffset: number,
): Promise<{ chunk: Buffer; offset: number }> {
  const { size } = await stat(filePath);
  const start = size < fromOffset ? 0 : fromOffset;
  if (size <= start) return { chunk: Buffer.alloc(0), offset: start };
  const fd = await open(filePath, 'r');
  try {
    const length = size - start;
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fd.read(buf, 0, length, start);
    return { chunk: buf.subarray(0, bytesRead), offset: start + bytesRead };
  } finally {
    await fd.close();
  }
}

/**
 * One sync tick: read newly-appended bytes, persist every COMPLETE line
 * verbatim to the transcript store, and carry the trailing incomplete bytes.
 * Splitting on the LF byte (never part of a multi-byte UTF-8 char) means each
 * persisted line is a complete byte sequence — safe to decode as UTF-8.
 */
export async function syncOnce(
  filePath: string,
  state: TailState,
  transcript: TranscriptStore,
  sessionId: string,
): Promise<TailState> {
  const { chunk, offset } = await readAppended(filePath, state.offset);
  // A rewrite (offset rewound below the prior offset) means claude rewrote /
  // compacted the file: discard the pending partial, and REPLACE the stored
  // transcript with the new content rather than appending it (which would
  // duplicate the whole log in the append-only store).
  //
  // KNOWN LIMITATIONS (acceptable for now — the only confirmed compaction path,
  // explicit `/compact`, APPENDS and never shrinks, §18, so this path is
  // defensive for unconfirmed auto-compact/rewrite behavior, §16):
  //  - A same-size rewrite (offset == prior) isn't detected as a reset.
  //  - If claude rewrites IN PLACE (truncate-then-write, not rename-atomic), a
  //    poll landing mid-rewrite could replace with a truncated snapshot until
  //    the write settles. Verify auto-compact's write strategy (§16) before
  //    relying on the shrink path; add a size-stabilization debounce if needed.
  const reset = offset < state.offset;
  const data = Buffer.concat([reset ? Buffer.alloc(0) : state.pending, chunk]);

  const lines: string[] = [];
  let start = 0;
  let nl = data.indexOf(LF, start);
  while (nl !== -1) {
    lines.push(data.subarray(start, nl).toString('utf8'));
    start = nl + 1;
    nl = data.indexOf(LF, start);
  }
  const pending = data.subarray(start);

  if (reset) {
    await transcript.replaceLines(sessionId, lines);
  } else if (lines.length > 0) {
    await transcript.appendLines(sessionId, lines);
  }
  return { offset, pending };
}

function fileExists(filePath: string): Promise<boolean> {
  return access(filePath, fsConstants.F_OK).then(
    () => true,
    () => false,
  );
}

/**
 * Poll a session's `.jsonl`, persisting appended lines verbatim until `signal`
 * aborts. Byte-offset polling (not `fs.watch`, which is unreliable on the
 * container's bind-mount/overlay filesystems). A transient read error (file
 * rotated/deleted mid-read, EBUSY) is swallowed so one blip can't end the sync;
 * the loop resumes when the file reappears.
 *
 * `startOffset` skips bytes already in the store — set it to the restored
 * file's size when resuming, so prior (already-persisted) lines aren't
 * duplicated. After abort, a final read flushes any lines claude wrote just
 * before the session ended (between the last poll and the abort). Resolves when
 * aborted.
 */
export async function syncTranscript(
  filePath: string,
  transcript: TranscriptStore,
  sessionId: string,
  opts: { pollMs?: number; signal?: AbortSignal; startOffset?: number } = {},
): Promise<void> {
  const pollMs = opts.pollMs ?? 200;
  let state: TailState = { offset: opts.startOffset ?? 0, pending: Buffer.alloc(0) };
  const tick = async (): Promise<void> => {
    if (await fileExists(filePath)) {
      try {
        state = await syncOnce(filePath, state, transcript, sessionId);
      } catch {
        // Transient — keep polling rather than terminating the sync.
      }
    }
  };
  for (;;) {
    if (opts.signal?.aborted) break;
    await tick();
    try {
      await sleep(pollMs, undefined, { signal: opts.signal });
    } catch {
      break; // aborted during the sleep
    }
  }
  // Final flush — capture lines written between the last poll and the abort. This
  // also deliberately runs when abort wins the race before the first poll: a very
  // short turn can emit its session and result frames back-to-back, causing the
  // owner to start and immediately stop this tail. Skipping the only read in that
  // window would silently lose the complete transcript.
  await tick();
}

/**
 * Write the session's durable transcript back to `filePath` (mkdir -p, mode
 * 0600 to match claude's own perms — enforced even if the file pre-exists).
 * This is the file `claude --resume` reads.
 */
export async function materializeToDisk(
  transcript: TranscriptStore,
  sessionId: string,
  filePath: string,
): Promise<boolean> {
  const content = await transcript.materialize(sessionId);
  // An EMPTY transcript is not a harmless no-op to write: `claude --resume` reads
  // a zero-byte file exactly like a missing conversation ("No conversation found
  // with session ID: …") and exits BEFORE emitting `system/init`, which ingest then
  // reports as a failed turn. Worse, the decoy file makes every later
  // `restoreIfMissing` a no-op, so the session can never recover. Leave the path
  // absent instead — nothing to restore is not the same as an empty transcript.
  if (content.length === 0) return false;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, { mode: 0o600 });
  await chmod(filePath, 0o600);
  return true;
}

/**
 * Recovery (§5a): if the transcript file is missing (e.g. container rebuild)
 * but the DB holds it, re-materialize it to disk so `--resume` finds it.
 * Returns true if a restore happened. The agent must resume from the SAME cwd
 * (the encoded folder name is derived from cwd) for claude to discover it.
 *
 * Restoring is deliberately unconditional once `filePath` is absent, even if a
 * transcript for the same session id sits in a sibling `projects/` folder. The
 * CLI opens exactly the folder its own encoding derives from the current cwd, so
 * a sibling is only evidence about some other cwd — skipping on it would leave
 * the one path the CLI actually reads empty, which is the very failure this
 * function exists to prevent. A redundant copy costs a file; a skipped restore
 * costs the conversation.
 */
export async function restoreIfMissing(
  transcript: TranscriptStore,
  sessionId: string,
  filePath: string,
): Promise<boolean> {
  if (await fileExists(filePath)) return false;
  return materializeToDisk(transcript, sessionId, filePath);
}
