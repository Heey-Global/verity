import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  InMemoryEventBus,
  SupervisorRunnerClient,
  type Backend,
  type RunResult,
} from '@verity/session';
import { createPostgresDb, EventStore, migrateToLatest } from '@verity/store';
import { unexpectedStderrLines } from './runner-claude-live-stderr.js';

const mode = process.argv[2];
if (mode !== 'start' && mode !== 'reattach') throw new Error('expected start or reattach mode');

const connectionString = process.env.VERITY_LIVE_SMOKE_POSTGRES_URL;
const runtimeDir = process.env.VERITY_LIVE_SMOKE_RUNTIME ?? '/runtime';
const worktree = process.env.VERITY_LIVE_SMOKE_WORKTREE ?? '/work';
if (connectionString === undefined) throw new Error('missing VERITY_LIVE_SMOKE_POSTGRES_URL');

const SESSION_ID = 'verity-claude-live-container-session';
const TURN_ID = 'claude-live-container-turn';
const START_ID = 'claude-live-container-start';
const db = createPostgresDb(connectionString);
const store = new EventStore(db);
const bus = new InMemoryEventBus();
const backend: Backend = {
  runnerSupervisorBackend: 'claude-acp',
  run: () => Promise.reject(new Error('live smoke backend must run through the supervisor')),
};
const client = new SupervisorRunnerClient(backend, {
  runtimeDir,
  store,
  bus,
  timeoutMs: 15_000,
});

try {
  await migrateToLatest(db);
  if (mode === 'start') {
    await store.createSession({ sessionId: SESSION_ID, worktree, model: 'smoke' });
    await store.markTurnRunning({ sessionId: SESSION_ID, promptSeq: 1 });
    await store.bindTurnIdentity(SESSION_ID, { turnId: TURN_ID, startCommandId: START_ID });
    bus.subscribe(SESSION_ID, (event) => {
      if (event.event.t === 'text' && event.event.delta.includes('before server restart')) {
        process.stdout.write('READY\n');
      }
    });
    const turn = client.startTurn(
      {
        store,
        storeSessionId: SESSION_ID,
        worktree,
        cwd: worktree,
        prompt: 'survive a hard server restart',
        model: 'smoke',
        turnId: TURN_ID,
        startCommandId: START_ID,
      },
      {},
    );
    const result: RunResult = await turn.result;
    throw new Error(
      `Server A unexpectedly observed the terminal result: ${JSON.stringify(result)}`,
    );
  }

  const parsedState: unknown = JSON.parse(
    await readFile(join(runtimeDir, 'turns', TURN_ID, 'state.json'), 'utf8'),
  );
  if (
    typeof parsedState !== 'object' ||
    parsedState === null ||
    !('protocolVersion' in parsedState) ||
    !Number.isSafeInteger(parsedState.protocolVersion)
  ) {
    throw new Error('Runner state has no valid protocol version');
  }
  const protocolVersion = parsedState.protocolVersion as number;
  const turn = client.attach(
    {
      turnId: TURN_ID,
      sessionId: SESSION_ID,
      protocolVersion,
      eventFilePath: join(runtimeDir, 'turns', TURN_ID, 'events.jsonl'),
      controlSocketPath: join(runtimeDir, 'turns', TURN_ID, 'control.sock'),
    },
    {},
  );
  const result = await turn.result;
  const eventFile = await readFile(join(runtimeDir, 'turns', TURN_ID, 'events.jsonl'), 'utf8');
  const backendSessionFrame = eventFile
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line): unknown => JSON.parse(line))
    .find(
      (frame) =>
        typeof frame === 'object' &&
        frame !== null &&
        'kind' in frame &&
        frame.kind === 'session' &&
        'id' in frame &&
        typeof frame.id === 'string',
    );
  if (
    typeof backendSessionFrame !== 'object' ||
    backendSessionFrame === null ||
    !('id' in backendSessionFrame) ||
    typeof backendSessionFrame.id !== 'string'
  ) {
    throw new Error('Runner stream has no backend session frame');
  }
  // The canonical events remain bound to SESSION_ID, while RunResult carries
  // the backend identity needed for a later ACP session/resume.
  const { stderr, ...terminal } = result;
  if (
    !isDeepStrictEqual(terminal, {
      sessionId: backendSessionFrame.id,
      exitCode: 0,
      aborted: false,
    } satisfies Omit<RunResult, 'stderr'>)
  ) {
    throw new Error(`unexpected result: ${JSON.stringify(result)}`);
  }
  // Every stderr line other than the adapter's own per-query diagnostic still
  // fails this gate; see unexpectedStderrLines for why that one is tolerated.
  const unexpectedStderr = unexpectedStderrLines(stderr);
  if (unexpectedStderr.length > 0) {
    throw new Error(`unexpected stderr: ${JSON.stringify(unexpectedStderr)}`);
  }
  const events = await store.getEvents(SESSION_ID);
  const text = events.filter((event) => event.t === 'text').map((event) => event.delta);
  if (JSON.stringify(text) !== JSON.stringify(['before server restart', 'after server restart'])) {
    throw new Error(`unexpected exactly-once text events: ${JSON.stringify(text)}`);
  }
  if ((await store.listRunningTurns()).some((row) => row.turnId === TURN_ID)) {
    throw new Error('terminal replay did not close the running-turn marker');
  }
  const frames = await db
    .selectFrom('runner_frames')
    .select(['frame_seq', 'terminal'])
    .where('turn_id', '=', TURN_ID)
    .orderBy('frame_seq', 'asc')
    .execute();
  const durableFrameCount = eventFile.split('\n').filter((line) => line.length > 0).length;
  const contiguous = frames.every((frame, index) => Number(frame.frame_seq) === index + 1);
  const terminalIndexes = frames.flatMap((frame, index) => (frame.terminal ? [index] : []));
  if (
    frames.length !== durableFrameCount ||
    !contiguous ||
    terminalIndexes.length !== 1 ||
    terminalIndexes[0] !== frames.length - 1
  ) {
    throw new Error(`unexpected frame claims: ${JSON.stringify(frames)}`);
  }
  process.stdout.write('PASS\n');
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
