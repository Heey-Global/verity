import type { Dirent } from 'node:fs';
import { open, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { sessionHomePath } from './session-home.js';
import { migrateSessionArtifact } from './session-home-migration.js';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  restoreIfMissing,
  materializeToDisk,
  syncTranscript,
  transcriptPath,
  type RunnerTranscriptSink,
} from '@verity/session';
import type { TranscriptStore } from '@verity/store';

/**
 * Server-side verbatim transcript persistence for the runner-supervisor path
 * (Stage 5b Slice 2). Implements the {@link RunnerTranscriptSink} port so the
 * {@link SupervisorRunnerClient} (in `@verity/session`) can drive it without the
 * server↔session package cycle.
 *
 * On this path the Sandbox worker runs `claude`, which writes its `.jsonl` under a
 * per-project subdir of the shared runner-runtime mount. That mount is the SAME
 * underlying storage on both sides: the sandbox sees it at `/run/verity-runner`, the
 * Server sees it at the host path `<dataVolumeRoot>/runners/<projectId>` (this
 * class's {@link ServerTranscriptOptions.runtimeDir}). So the Server can read/write
 * the exact file claude reads, and owns restore-before-resume + tail-into-DB — the
 * in-sandbox worker needs no database.
 *
 * Reuses `transcript-sync.ts` verbatim (no reimplementation of the line-faithful tail
 * or the shrink→`replaceLines` rewrite path): the file path is built with the shared
 * mount as claude's home, and the store is keyed by the CLAUDE session id under the
 * cwd claude runs in — identical keying to the in-process worker.
 */
export const RUNNER_CLAUDE_HOME_DIRNAME = 'claude';
export const RUNNER_CODEX_SESSIONS_DIRNAME = 'codex-sessions';

export interface ServerTranscriptOptions {
  /** Server-side host path of the runner-runtime dir: `<dataVolumeRoot>/runners/<projectId>`.
   * The worker sees the same storage at `/run/verity-runner`. */
  runtimeDir: string;
  veritySessionId?: string;
  /** The durable verbatim transcript store (the same one the in-process path uses). */
  transcript: TranscriptStore;
  /** Tail poll interval (ms); defaults to the transport's own default. */
  pollMs?: number | undefined;
}

export class ServerTranscript implements RunnerTranscriptSink {
  constructor(private readonly options: ServerTranscriptOptions) {}

  /**
   * Host path of the shared `.jsonl` for a claude session, mirroring the sandbox
   * worker's `<CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<sessionId>.jsonl`. `cwd`
   * is the path claude runs in (the sandbox worktree, e.g. `/work`) — it drives the
   * encoded `projects/` folder name and must match on both sides.
   */
  transcriptFile(sessionId: string, cwd: string): string {
    return transcriptPath({
      cwd,
      sessionId,
      claudeHome: join(
        this.options.veritySessionId
          ? sessionHomePath(this.options.runtimeDir, this.options.veritySessionId)
          : this.options.runtimeDir,
        RUNNER_CLAUDE_HOME_DIRNAME,
      ),
    });
  }

  async restoreForResume(
    backendSessionId: string,
    cwd: string,
    storeSessionId: string,
  ): Promise<number> {
    const file = this.transcriptFile(backendSessionId, cwd);
    if (this.options.veritySessionId) {
      const legacy = transcriptPath({
        cwd,
        sessionId: backendSessionId,
        claudeHome: join(this.options.runtimeDir, RUNNER_CLAUDE_HOME_DIRNAME),
      });
      await migrateSessionArtifact(legacy, file, this.options.runtimeDir);
      await migrateSessionArtifact(
        legacy.replace(/\.jsonl$/u, ''),
        file.replace(/\.jsonl$/u, ''),
        this.options.runtimeDir,
      );
    }
    await restoreIfMissing(this.options.transcript, storeSessionId, file, {
      rootDir: this.options.runtimeDir,
    });
    // Seed the tail past the bytes already durable, so a resume never re-appends
    // the restored prefix (mirrors the in-process worker's `startOffset`).
    return await fileSize(file);
  }

  async tail(
    backendSessionId: string,
    cwd: string,
    storeSessionId: string,
    startOffset: number,
    signal: AbortSignal,
  ): Promise<void> {
    await syncTranscript(
      this.transcriptFile(backendSessionId, cwd),
      this.options.transcript,
      storeSessionId,
      {
        signal,
        startOffset,
        rootDir: this.options.runtimeDir,
        ...(this.options.pollMs !== undefined ? { pollMs: this.options.pollMs } : {}),
      },
    );
  }
}

async function listCodexRollouts(dir: string, sessionId: string): Promise<string[]> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(dir, { encoding: 'utf8', withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(`-${sessionId}.jsonl`))
    .map((entry) => join(dir, entry.name))
    .sort();
  const exact: string[] = [];
  for (const file of candidates) {
    if (await codexRolloutHasSession(file, sessionId)) exact.push(file);
  }
  const nested: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    nested.push(...(await listCodexRollouts(join(dir, entry.name), sessionId)));
  }
  return [...exact, ...nested];
}

/** Locate every rollout owned by one Codex session under a Runner runtime.
 * Ephemeral meta queries use this to remove their backend artifacts without
 * touching concurrent sessions. */
export async function codexRolloutFiles(runtimeDir: string, sessionId: string): Promise<string[]> {
  return await listCodexRollouts(join(runtimeDir, RUNNER_CODEX_SESSIONS_DIRNAME), sessionId);
}

async function codexRolloutHasSession(file: string, sessionId: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(file, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== 'object' || parsed === null || !('payload' in parsed)) continue;
      const payload = parsed.payload;
      if (typeof payload !== 'object' || payload === null) continue;
      if (
        ('id' in payload && payload.id === sessionId) ||
        ('session_id' in payload && payload.session_id === sessionId)
      )
        return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function findCodexRollout(dir: string, sessionId: string): Promise<string | undefined> {
  const files = await listCodexRollouts(dir, sessionId);
  const genuine = files.filter((file) => !file.includes(`${sep}verity-restored${sep}`));
  if (genuine.length > 0) {
    const dated = await Promise.all(
      genuine.map(async (file) => ({ file, mtimeMs: (await stat(file)).mtimeMs })),
    );
    dated.sort((a, b) => b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file));
    return dated[0]?.file;
  }
  const restored = restoredCodexFile(dir, sessionId);
  return (await codexRolloutHasSession(restored, sessionId)) ? restored : undefined;
}

const MAX_FOUR_DIGIT_YEAR_MILLIS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function restoredCodexFile(dir: string, sessionId: string): string {
  // Codex reads a paginated rollout only under its canonical name,
  // `rollout-YYYY-MM-DDThh-mm-ss-<thread-id>.jsonl`, and refuses to resume any
  // other ("does not have a canonical rollout filename"). The time in the name
  // is not checked against the contents; a v7 thread id carries its creation
  // time, so that is what goes there.
  if (UUID.test(sessionId)) {
    return join(
      dir,
      'verity-restored',
      `rollout-${codexRolloutTimestamp(sessionId)}-${sessionId}.jsonl`,
    );
  }
  return legacyRestoredCodexFile(dir, sessionId);
}

function codexRolloutTimestamp(threadId: string): string {
  const millis = threadId[14] === '7' ? parseInt(threadId.replaceAll('-', '').slice(0, 12), 16) : 0;
  // Past year 9999 the ISO form gains a sign and the name would not be canonical.
  const created = new Date(millis <= MAX_FOUR_DIGIT_YEAR_MILLIS ? millis : 0);
  return created.toISOString().slice(0, 19).replaceAll(':', '-');
}

/** The name restores used before the canonical one. Not a thread id Codex can
 * resume under, and the only name an id that is no UUID at all can have. */
function legacyRestoredCodexFile(dir: string, sessionId: string): string {
  // Native Codex discovers rollouts by their `-<thread-id>.jsonl` suffix, so
  // preserve ordinary thread IDs. Encode only values that are unsafe as one
  // path segment; the metadata inside the rollout still carries the original ID.
  const fileSessionId =
    /^[A-Za-z0-9._-]+$/u.test(sessionId) && sessionId !== '.' && sessionId !== '..'
      ? sessionId
      : `encoded-${Buffer.from(sessionId, 'utf8').toString('base64url')}`;
  return join(dir, 'verity-restored', `rollout-${fileSessionId}.jsonl`);
}

/** A Sandbox restored before the canonical name keeps that copy in its runtime,
 * and Codex would keep finding it by its id suffix and refusing it. Move it to
 * the canonical name, so it is resumed instead of shadowing a second restore. */
async function migrateLegacyRestoredCodexFile(dir: string, sessionId: string): Promise<void> {
  const legacy = legacyRestoredCodexFile(dir, sessionId);
  const canonical = restoredCodexFile(dir, sessionId);
  if (legacy === canonical) return;
  const legacySize = await fileSize(legacy);
  if (legacySize === 0 && !(await exists(legacy))) return;
  const ignoreGone = (error: NodeJS.ErrnoException): void => {
    // A concurrent resume of the same thread may have moved it already.
    if (error.code !== 'ENOENT') throw error;
  };
  // Keep whichever copy holds more of the thread; Codex may have appended to
  // either. A legacy copy without this thread's metadata holds nothing to keep,
  // and its name is the one Verity derives for this id, so it is Verity's own.
  // A native dated rollout is what resumes; a renamed copy beside it would only
  // be a second canonical file for the same thread.
  const native = (await listCodexRollouts(dir, sessionId)).some(
    (file) => !file.includes(`${sep}verity-restored${sep}`),
  );
  if (
    !native &&
    (await codexRolloutHasSession(legacy, sessionId)) &&
    (!(await codexRolloutHasSession(canonical, sessionId)) ||
      legacySize > (await fileSize(canonical)))
  ) {
    await rename(legacy, canonical).catch(ignoreGone);
  } else {
    await rm(legacy, { force: true });
  }
}

async function waitForCodexRollout(
  dir: string,
  sessionId: string,
  signal: AbortSignal,
  pollMs: number,
): Promise<string | undefined> {
  for (;;) {
    const file = await findCodexRollout(dir, sessionId);
    if (file !== undefined) return file;
    if (signal.aborted) return await findCodexRollout(dir, sessionId);
    try {
      await sleep(pollMs, undefined, { signal });
    } catch {
      return await findCodexRollout(dir, sessionId);
    }
  }
}

/** Durable Codex rollout persistence for Sandbox recreation. Codex owns the
 * rollout format; Verity stores and restores its JSONL bytes without parsing. */
export class ServerCodexTranscript implements RunnerTranscriptSink {
  constructor(private readonly options: ServerTranscriptOptions) {}

  private sessionsDir(): string {
    return this.options.veritySessionId
      ? join(
          sessionHomePath(this.options.runtimeDir, this.options.veritySessionId),
          'codex',
          'sessions',
        )
      : join(this.options.runtimeDir, RUNNER_CODEX_SESSIONS_DIRNAME);
  }

  private restoredFile(sessionId: string): string {
    return restoredCodexFile(this.sessionsDir(), sessionId);
  }

  async restoreForResume(
    backendSessionId: string,
    _cwd: string,
    storeSessionId: string,
  ): Promise<number> {
    void _cwd;
    if (this.options.veritySessionId) {
      for (const legacy of await codexRolloutFiles(this.options.runtimeDir, backendSessionId))
        await migrateSessionArtifact(
          legacy,
          join(this.sessionsDir(), 'legacy', basename(legacy)),
          this.options.runtimeDir,
        );
    }
    await migrateLegacyRestoredCodexFile(this.sessionsDir(), backendSessionId);
    const existing = await findCodexRollout(this.sessionsDir(), backendSessionId);
    const file = existing ?? this.restoredFile(backendSessionId);
    if (existing === undefined)
      await materializeToDisk(this.options.transcript, storeSessionId, file, {
        rootDir: this.options.runtimeDir,
      });
    return await fileSize(file);
  }

  async tail(
    backendSessionId: string,
    _cwd: string,
    storeSessionId: string,
    startOffset: number,
    signal: AbortSignal,
  ): Promise<void> {
    const file = await waitForCodexRollout(
      this.sessionsDir(),
      backendSessionId,
      signal,
      this.options.pollMs ?? 200,
    );
    if (file === undefined) return;
    await syncTranscript(file, this.options.transcript, storeSessionId, {
      signal,
      startOffset,
      rootDir: this.options.runtimeDir,
      ...(this.options.pollMs !== undefined ? { pollMs: this.options.pollMs } : {}),
    });
  }
}

async function exists(file: string): Promise<boolean> {
  return await stat(file).then(
    () => true,
    () => false,
  );
}

/** Current size of `file`, or 0 if it does not exist yet (a fresh session). */
async function fileSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}
