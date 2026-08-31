import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { InMemoryEventBus, SupervisorRunnerClient, type Backend } from '@verity/session';
import { createPostgresDb, EventStore, migrateToLatest, TranscriptStore } from '@verity/store';
import { unexpectedStderrLines } from './runner-claude-live-stderr.js';
import { ServerTranscript } from './runner-transcript.js';

const mode = process.argv[2];
if (mode !== 'seed' && mode !== 'resume') throw new Error('expected seed or resume mode');

const connectionString = process.env.VERITY_LIVE_SMOKE_POSTGRES_URL;
const runtimeDir = process.env.VERITY_LIVE_SMOKE_RUNTIME ?? '/runtime';
const worktree = process.env.VERITY_LIVE_SMOKE_WORKTREE ?? '/work';
if (connectionString === undefined) throw new Error('missing VERITY_LIVE_SMOKE_POSTGRES_URL');

const STORE_SESSION_ID = 'claude-live-recreate-store-session';
const backendSessionPath = join(worktree, 'backend-session-id');
const resumeSessionId =
  mode === 'resume' ? (await readFile(backendSessionPath, 'utf8')).trim() : undefined;
const seedLine = (sessionId: string): string =>
  JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: worktree,
    sessionId,
    version: 'recreate-smoke',
    type: 'user',
    message: { role: 'user', content: 'seed before sandbox recreate' },
    uuid: '00000000-0000-4000-8000-000000000010',
    timestamp: '2026-08-13T00:00:00.000Z',
  });
const resumedLine = (sessionId: string): string =>
  JSON.stringify({
    parentUuid: '00000000-0000-4000-8000-000000000010',
    isSidechain: false,
    cwd: worktree,
    sessionId,
    version: 'recreate-smoke',
    type: 'assistant',
    message: {
      id: 'after-recreate-transcript',
      type: 'message',
      role: 'assistant',
      model: 'smoke',
      content: [{ type: 'text', text: 'after sandbox recreate' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 3 },
    },
    uuid: '00000000-0000-4000-8000-000000000016',
    timestamp: '2026-08-13T00:00:01.000Z',
  });
const turnId = mode === 'seed' ? 'claude-recreate-seed-turn' : 'claude-recreate-resume-turn';
const startCommandId =
  mode === 'seed' ? 'claude-recreate-seed-start' : 'claude-recreate-resume-start';
const db = createPostgresDb(connectionString);
const store = new EventStore(db);
const transcript = new TranscriptStore(db);
const bus = new InMemoryEventBus();
const backend: Backend = {
  runnerSupervisorBackend: 'claude-acp',
  run: () => Promise.reject(new Error('live recreate smoke must use the supervisor')),
};
const serverTranscript = new ServerTranscript({ runtimeDir, transcript, pollMs: 10 });
const client = new SupervisorRunnerClient(backend, {
  runtimeDir,
  store,
  bus,
  transcript: serverTranscript,
  timeoutMs: 15_000,
});

try {
  await migrateToLatest(db);
  if (mode === 'seed') {
    await store.createSession({ sessionId: STORE_SESSION_ID, worktree, model: 'smoke' });
  }
  await store.markTurnRunning({ sessionId: STORE_SESSION_ID, promptSeq: mode === 'seed' ? 1 : 2 });
  await store.bindTurnIdentity(STORE_SESSION_ID, { turnId, startCommandId });

  const turn = client.startTurn(
    {
      store,
      storeSessionId: STORE_SESSION_ID,
      worktree,
      cwd: worktree,
      prompt: mode === 'seed' ? 'seed before sandbox recreate' : 'resume after sandbox recreate',
      model: 'smoke',
      turnId,
      startCommandId,
      ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
    },
    {},
  );
  const result = await turn.result;
  if (
    result.sessionId === undefined ||
    (resumeSessionId !== undefined && result.sessionId !== resumeSessionId)
  ) {
    throw new Error(`unexpected backend session id: ${JSON.stringify(result.sessionId)}`);
  }
  const { stderr, ...terminal } = result;
  if (
    !isDeepStrictEqual(terminal, {
      sessionId: result.sessionId,
      exitCode: 0,
      aborted: false,
    })
  ) {
    throw new Error(`unexpected result: ${JSON.stringify(result)}`);
  }
  // Every stderr line other than the adapter's own per-query diagnostic still
  // fails this gate; see unexpectedStderrLines for why that one is tolerated.
  const unexpectedStderr = unexpectedStderrLines(stderr);
  if (unexpectedStderr.length > 0) {
    throw new Error(`unexpected stderr: ${JSON.stringify(unexpectedStderr)}`);
  }
  if (mode === 'seed') await writeFile(backendSessionPath, `${result.sessionId}\n`);
  const expectedTranscript =
    mode === 'seed'
      ? `${seedLine(result.sessionId)}\n`
      : `${seedLine(result.sessionId)}\n${resumedLine(result.sessionId)}\n`;
  const materialized = await transcript.materialize(STORE_SESSION_ID);
  if (materialized !== expectedTranscript) {
    throw new Error(`unexpected durable transcript: ${JSON.stringify(materialized)}`);
  }
  if ((await store.listRunningTurns()).some((row) => row.turnId === turnId)) {
    throw new Error('terminal result did not close the running-turn marker');
  }

  if (mode === 'resume') {
    const events = await store.getEvents(STORE_SESSION_ID);
    const text = events.filter((event) => event.t === 'text').map((event) => event.delta);
    if (!isDeepStrictEqual(text, ['before sandbox recreate', 'after sandbox recreate'])) {
      throw new Error(`unexpected exactly-once text events: ${JSON.stringify(text)}`);
    }
    const observed: unknown = JSON.parse(
      await readFile(join(worktree, 'recreate-observed.json'), 'utf8'),
    );
    if (
      typeof observed !== 'object' ||
      observed === null ||
      !('resumeId' in observed) ||
      observed.resumeId !== resumeSessionId ||
      !('restored' in observed) ||
      observed.restored !== `${seedLine(result.sessionId)}\n` ||
      !('databaseEnvironment' in observed) ||
      !Array.isArray(observed.databaseEnvironment) ||
      observed.databaseEnvironment.length !== 0
    ) {
      throw new Error(`invalid worker observation: ${JSON.stringify(observed)}`);
    }
  }
  process.stdout.write(`${mode === 'seed' ? 'SEED_PASS' : 'RESUME_PASS'}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
