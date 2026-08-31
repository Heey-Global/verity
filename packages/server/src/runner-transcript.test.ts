import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TranscriptStore, type RunnerFrameIngest } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import {
  InMemoryEventBus,
  stampFrame,
  SupervisorRunnerClient,
  type Backend,
} from '@verity/session';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  RUNNER_CLAUDE_HOME_DIRNAME,
  RUNNER_CODEX_SESSIONS_DIRNAME,
  codexRolloutFiles,
  ServerCodexTranscript,
  ServerTranscript,
} from './runner-transcript.js';

let ctx: TestDb;
let transcript: TranscriptStore;
let runtimeDir: string;

const CLAUDE_SESSION = 'claude-session-1';
const CWD = '/work';

beforeAll(async () => {
  ctx = await createTestDb();
  transcript = new TranscriptStore(ctx.db);
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.store.createSession({ sessionId: CLAUDE_SESSION, worktree: '/wt', model: 'm' });
  runtimeDir = await mkdtemp(join(tmpdir(), 'verity-runner-transcript-'));
});

afterEach(async () => {
  await rm(runtimeDir, { recursive: true, force: true });
});

/** Wait until `predicate` holds (polling the store while the tail runs). */
async function until(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error('condition not met before deadline');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('ServerTranscript', () => {
  it('builds the shared path under <runtimeDir>/claude/projects/<encoded-cwd>/<id>.jsonl', () => {
    const server = new ServerTranscript({ runtimeDir, transcript });
    expect(server.transcriptFile(CLAUDE_SESSION, CWD)).toBe(
      join(runtimeDir, RUNNER_CLAUDE_HOME_DIRNAME, 'projects', '-work', `${CLAUDE_SESSION}.jsonl`),
    );
  });

  it('restoreForResume materializes the durable transcript to the shared path and returns its size', async () => {
    // Two prior lines already durable in the store (a resumed session).
    await transcript.appendLines(CLAUDE_SESSION, ['{"a":1}', '{"b":2}']);
    const server = new ServerTranscript({ runtimeDir, transcript });
    const file = server.transcriptFile(CLAUDE_SESSION, CWD);

    const offset = await server.restoreForResume(CLAUDE_SESSION, CWD, CLAUDE_SESSION);

    const content = await readFile(file, 'utf8');
    expect(content).toBe('{"a":1}\n{"b":2}\n');
    // Offset seeds the tail past the already-persisted bytes (line-faithful: +1 LF each).
    expect(offset).toBe(content.length);
    expect(offset).toBe((await stat(file)).size);
  });

  it('restoreForResume does not clobber an existing on-disk transcript (durable mount survives)', async () => {
    await transcript.appendLines(CLAUDE_SESSION, ['{"db":true}']);
    const server = new ServerTranscript({ runtimeDir, transcript });
    const file = server.transcriptFile(CLAUDE_SESSION, CWD);
    // A newer on-disk file (claude already wrote more than the DB holds).
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '{"disk":1}\n{"disk":2}\n', { mode: 0o600 });

    const offset = await server.restoreForResume(CLAUDE_SESSION, CWD, CLAUDE_SESSION);

    // restoreIfMissing is a no-op when the file exists; the offset is the disk size.
    expect(await readFile(file, 'utf8')).toBe('{"disk":1}\n{"disk":2}\n');
    expect(offset).toBe('{"disk":1}\n{"disk":2}\n'.length);
  });

  it('tail persists appended lines verbatim and captures a shrink→replaceLines rewrite', async () => {
    const server = new ServerTranscript({ runtimeDir, transcript, pollMs: 5 });
    const file = server.transcriptFile(CLAUDE_SESSION, CWD);
    // Fresh session: claude writes three lines while the tail runs.
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '{"x":1}\n{"x":2}\n{"x":3}\n', { mode: 0o600 });

    const abort = new AbortController();
    const done = server.tail(CLAUDE_SESSION, CWD, CLAUDE_SESSION, 0, abort.signal);

    await until(async () => (await transcript.getLines(CLAUDE_SESSION)).length === 3);
    expect(await transcript.getLines(CLAUDE_SESSION)).toEqual(['{"x":1}', '{"x":2}', '{"x":3}']);

    // A rewrite/compaction shrinks the file below the tail offset: syncOnce detects
    // the reset and REPLACES the stored transcript rather than appending.
    await writeFile(file, '{"compacted":true}\n', { mode: 0o600 });
    await until(async () => {
      const lines = await transcript.getLines(CLAUDE_SESSION);
      return lines.length === 1 && lines[0] === '{"compacted":true}';
    });

    abort.abort();
    await done;
    expect(await transcript.getLines(CLAUDE_SESSION)).toEqual(['{"compacted":true}']);
  });

  it('uses the backend id for the file and the Verity session id for durable rows', async () => {
    const backendSessionId = 'acp-session-distinct-from-store';
    const server = new ServerTranscript({ runtimeDir, transcript, pollMs: 5 });
    const file = server.transcriptFile(backendSessionId, CWD);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '{"acp":true}\n', { mode: 0o600 });

    const abort = new AbortController();
    const done = server.tail(backendSessionId, CWD, CLAUDE_SESSION, 0, abort.signal);
    await until(async () => (await transcript.getLines(CLAUDE_SESSION)).length === 1);
    abort.abort();
    await done;

    expect(await transcript.getLines(CLAUDE_SESSION)).toEqual(['{"acp":true}']);
  });

  it('a resume round-trip appends only NEW lines past the restored offset', async () => {
    // Prior transcript is durable; restore it, then claude appends one more line.
    await transcript.appendLines(CLAUDE_SESSION, ['{"prior":1}']);
    const server = new ServerTranscript({ runtimeDir, transcript, pollMs: 5 });
    const file = server.transcriptFile(CLAUDE_SESSION, CWD);
    const startOffset = await server.restoreForResume(CLAUDE_SESSION, CWD, CLAUDE_SESSION);

    const abort = new AbortController();
    const done = server.tail(CLAUDE_SESSION, CWD, CLAUDE_SESSION, startOffset, abort.signal);
    await writeFile(file, '{"prior":1}\n{"resumed":2}\n', { mode: 0o600 });

    await until(async () => (await transcript.getLines(CLAUDE_SESSION)).length === 2);
    abort.abort();
    await done;
    // No duplicate of the restored prefix — only the new line was appended.
    expect(await transcript.getLines(CLAUDE_SESSION)).toEqual(['{"prior":1}', '{"resumed":2}']);
  });

  it('recreates an empty Sandbox from the durable transcript before remote resume', async () => {
    const prior = '{"type":"assistant","message":"survived"}';
    const resumed = '{"type":"assistant","message":"continued"}';
    await transcript.appendLine(CLAUDE_SESSION, prior);

    // Model a full Sandbox replacement: the old runtime (including Claude home) is
    // gone, while PostgreSQL-backed transcript state remains on the Server side.
    await rm(runtimeDir, { recursive: true, force: true });
    await mkdir(runtimeDir, { recursive: true });
    const serverTranscript = new ServerTranscript({ runtimeDir, transcript, pollMs: 5 });
    const transcriptFile = serverTranscript.transcriptFile(CLAUDE_SESSION, CWD);
    const turnId = 'turn-after-recreate';
    const startCommandId = 'start-after-recreate';
    const turnDir = join(runtimeDir, 'turns', turnId);
    const requests: Array<Record<string, unknown>> = [];
    let startCount = 0;
    await ctx.store.markTurnRunning({ sessionId: CLAUDE_SESSION, promptSeq: 0 });
    await ctx.store.bindTurnIdentity(CLAUDE_SESSION, { turnId, startCommandId });

    const supervisor = createServer((peer) => {
      let buffered = '';
      const handleData = (data: Buffer): void => {
        buffered += data.toString('utf8');
        const newline = buffered.indexOf('\n');
        if (newline < 0) return;
        peer.off('data', handleData);
        const line = buffered.slice(0, newline);
        void (async () => {
          const request = JSON.parse(line) as Record<string, unknown>;
          requests.push(request);
          if (request.kind === 'start-turn') {
            startCount += 1;
            // Restore is a Server responsibility and must finish before StartTurn. The
            // worker receives only filesystem/runtime fields, never a DB handle or URL.
            expect(await readFile(transcriptFile, 'utf8')).toBe(`${prior}\n`);
            expect(Object.keys(request).some((key) => /postgres|database|dburl/iu.test(key))).toBe(
              false,
            );
            await writeFile(transcriptFile, `${prior}\n${resumed}\n`, { mode: 0o600 });
            await mkdir(turnDir, { recursive: true });
            const frames = [
              stampFrame(
                { kind: 'session', id: CLAUDE_SESSION },
                { turnId, runnerInstanceId: 'runner-after-recreate', frameSeq: 1 },
              ),
              stampFrame(
                {
                  kind: 'result',
                  result: { sessionId: CLAUDE_SESSION, exitCode: 0, stderr: '', aborted: false },
                },
                { turnId, runnerInstanceId: 'runner-after-recreate', frameSeq: 2 },
              ),
            ];
            await writeFile(
              join(turnDir, 'events.jsonl'),
              `${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`,
            );
          }
          peer.end(
            `${JSON.stringify({
              ok: true,
              ...(request.kind === 'start-turn' ? { outcome: 'created' } : {}),
              state: {
                protocolVersion: 1,
                turnId,
                startCommandId,
                runnerInstanceId: 'runner-after-recreate',
                status: request.kind === 'start-turn' ? 'running' : 'settled',
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            })}\n`,
          );
        })().catch((error: unknown) => peer.destroy(error as Error));
      };
      peer.on('data', handleData);
    });
    await new Promise<void>((resolve, reject) => {
      supervisor.once('error', reject);
      supervisor.listen(join(runtimeDir, 'supervisor.sock'), resolve);
    });

    const ingested: RunnerFrameIngest[] = [];
    const frameStore = {
      ingestRunnerFrame: async (sessionId: string, frame: RunnerFrameIngest) => {
        ingested.push(frame);
        return await ctx.store.ingestRunnerFrame(sessionId, frame);
      },
    };
    const client = new SupervisorRunnerClient({ runnerSupervisorBackend: 'codex-acp' } as Backend, {
      runtimeDir,
      store: frameStore,
      bus: new InMemoryEventBus(),
      transcript: serverTranscript,
    });

    try {
      const turn = client.startTurn(
        {
          store: {} as never,
          worktree: CWD,
          cwd: CWD,
          storeSessionId: CLAUDE_SESSION,
          turnId,
          startCommandId,
          resumeSessionId: CLAUDE_SESSION,
        },
        {},
      );
      await expect(turn.result).resolves.toMatchObject({
        sessionId: CLAUDE_SESSION,
        exitCode: 0,
      });
    } finally {
      await new Promise<void>((resolve) => supervisor.close(() => resolve()));
    }

    expect(startCount).toBe(1);
    expect(requests[0]).toMatchObject({
      kind: 'start-turn',
      resumeSessionId: CLAUDE_SESSION,
    });
    expect(ingested.map((frame) => frame.frameSeq)).toEqual([1, 2]);
    expect(await ctx.store.listRunningTurns()).toEqual([]);
    await expect(
      Promise.all(ingested.map((frame) => ctx.store.ingestRunnerFrame(CLAUDE_SESSION, frame))),
    ).resolves.toEqual([{ outcome: 'duplicate' }, { outcome: 'duplicate' }]);
    expect(await ctx.store.listRunningTurns()).toEqual([]);
    expect(await transcript.getLines(CLAUDE_SESSION)).toEqual([prior, resumed]);
  });
});

describe('ServerCodexTranscript', () => {
  it('locates only rollouts belonging to the requested ephemeral session', async () => {
    const sessionsDir = join(runtimeDir, RUNNER_CODEX_SESSIONS_DIRNAME, '2026', '08', '13');
    await mkdir(sessionsDir, { recursive: true });
    const own = join(sessionsDir, `rollout-${CLAUDE_SESSION}.jsonl`);
    const other = join(sessionsDir, 'rollout-other-session.jsonl');
    await writeFile(
      own,
      `${JSON.stringify({ type: 'session_meta', payload: { id: CLAUDE_SESSION } })}\n`,
    );
    await writeFile(
      other,
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'other-session' } })}\n`,
    );

    await expect(codexRolloutFiles(runtimeDir, CLAUDE_SESSION)).resolves.toEqual([own]);
  });

  it('waits for Codex to create its dated rollout instead of tailing a fallback path', async () => {
    const server = new ServerCodexTranscript({ runtimeDir, transcript, pollMs: 5 });
    const abort = new AbortController();
    const done = server.tail(CLAUDE_SESSION, CWD, CLAUDE_SESSION, 0, abort.signal);
    const file = join(
      runtimeDir,
      RUNNER_CODEX_SESSIONS_DIRNAME,
      '2026',
      '07',
      '21',
      `rollout-${CLAUDE_SESSION}.jsonl`,
    );
    await mkdir(dirname(file), { recursive: true });
    const late = JSON.stringify({ type: 'session_meta', payload: { id: CLAUDE_SESSION } });
    await writeFile(file, `${late}\n`, { mode: 0o600 });
    await until(async () => (await transcript.getLines(CLAUDE_SESSION)).length === 1);
    abort.abort();
    await done;
    expect(await transcript.getLines(CLAUDE_SESSION)).toEqual([late]);
  });

  it('restores a rollout and appends only new Codex lines after resume', async () => {
    const prior = JSON.stringify({ type: 'session_meta', payload: { id: CLAUDE_SESSION } });
    const resumed = JSON.stringify({ type: 'event_msg', payload: { type: 'turn_complete' } });
    await transcript.appendLines(CLAUDE_SESSION, [prior]);
    const server = new ServerCodexTranscript({ runtimeDir, transcript, pollMs: 5 });

    const offset = await server.restoreForResume(CLAUDE_SESSION, CWD, CLAUDE_SESSION);
    const file = join(
      runtimeDir,
      RUNNER_CODEX_SESSIONS_DIRNAME,
      'verity-restored',
      `rollout-${CLAUDE_SESSION}.jsonl`,
    );
    expect(await readFile(file, 'utf8')).toBe(`${prior}\n`);

    const abort = new AbortController();
    const done = server.tail(CLAUDE_SESSION, CWD, CLAUDE_SESSION, offset, abort.signal);
    await writeFile(file, `${prior}\n${resumed}\n`, { mode: 0o600 });
    await until(async () => (await transcript.getLines(CLAUDE_SESSION)).length === 2);
    abort.abort();
    await done;
    expect(await transcript.getLines(CLAUDE_SESSION)).toEqual([prior, resumed]);
  });

  it('ignores colliding rollout ids and prefers a real dated rollout over the fallback', async () => {
    const sessions = join(runtimeDir, RUNNER_CODEX_SESSIONS_DIRNAME);
    const real = join(sessions, '2026', '07', '21', `rollout-${CLAUDE_SESSION}.jsonl`);
    const fallback = join(sessions, 'verity-restored', `rollout-${CLAUDE_SESSION}.jsonl`);
    const collision = join(sessions, '2026', '07', '21', `rollout-not-${CLAUDE_SESSION}.jsonl`);
    await mkdir(dirname(real), { recursive: true });
    await mkdir(dirname(fallback), { recursive: true });
    const realLine = JSON.stringify({ type: 'session_meta', payload: { id: CLAUDE_SESSION } });
    await writeFile(real, `${realLine}\n`);
    await writeFile(fallback, `${realLine}\n`);
    await writeFile(collision, '{"type":"session_meta","payload":{"id":"other"}}\n');
    const server = new ServerCodexTranscript({ runtimeDir, transcript, pollMs: 5 });
    const offset = await server.restoreForResume(CLAUDE_SESSION, CWD, CLAUDE_SESSION);
    expect(offset).toBe(`${realLine}\n`.length);
  });

  it('prefers the newest genuine rollout when multiple files match a session', async () => {
    const sessions = join(runtimeDir, RUNNER_CODEX_SESSIONS_DIRNAME);
    const older = join(sessions, '2026', '07', '20', `rollout-${CLAUDE_SESSION}.jsonl`);
    const newer = join(sessions, '2026', '07', '21', `rollout-${CLAUDE_SESSION}.jsonl`);
    const meta = JSON.stringify({ type: 'session_meta', payload: { id: CLAUDE_SESSION } });
    await mkdir(dirname(older), { recursive: true });
    await mkdir(dirname(newer), { recursive: true });
    await writeFile(older, `${meta}\nold\n`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(newer, `${meta}\nnewest\n`);
    const server = new ServerCodexTranscript({ runtimeDir, transcript, pollMs: 5 });
    await expect(server.restoreForResume(CLAUDE_SESSION, CWD, CLAUDE_SESSION)).resolves.toBe(
      `${meta}\nnewest\n`.length,
    );
  });

  it('encodes a hostile session id inside the restored directory', async () => {
    const hostile = '../../outside';
    const prior = JSON.stringify({ type: 'session_meta', payload: { id: hostile } });
    await ctx.store.createSession({ sessionId: hostile, worktree: '/hostile', model: 'm' });
    await transcript.appendLines(hostile, [prior]);
    const server = new ServerCodexTranscript({ runtimeDir, transcript, pollMs: 5 });
    await server.restoreForResume(hostile, CWD, hostile);
    const restored = join(
      runtimeDir,
      RUNNER_CODEX_SESSIONS_DIRNAME,
      'verity-restored',
      `rollout-encoded-${Buffer.from(hostile).toString('base64url')}.jsonl`,
    );
    await expect(readFile(restored, 'utf8')).resolves.toBe(`${prior}\n`);
  });
});
