import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PermissionDecision, PermissionRequest } from '@verity/adapter-claude';
import type { AgentEvent } from '@verity/events';
import {
  createPostgresDb,
  EventStore,
  migrateToLatest,
  type Database,
  type SequencedEvent,
} from '@verity/store';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Backend } from './backend.js';
import type { RunResult, RunTurnOptions, SteerMessage } from './backend-contract.js';
import { InMemoryEventBus } from './bus.js';
import { FileTailRunnerClient } from './file-tail-runner-client.js';
import { RunnerServer } from './runner-server.js';

const connectionString = process.env.VERITY_TEST_POSTGRES_URL;
const describePostgres = connectionString === undefined ? describe.skip : describe;
const SESSION_ID = 'postgres-two-server-cutover-session';
const TURN_ID = 'postgres-two-server-cutover-turn';
const WORKTREE = '/wt/postgres-two-server-cutover';
const EVENTS: readonly AgentEvent[] = [
  { t: 'text', delta: 'before cutover' },
  { t: 'text', delta: 'during cutover' },
];
const PERMISSION: PermissionRequest = {
  requestId: 'cutover-permission-request',
  toolName: 'Bash',
  input: { command: 'printf cutover' },
  toolUseId: 'cutover-tool',
};
const PERMISSION_EVENT: AgentEvent = {
  t: 'permission',
  id: PERMISSION.toolUseId,
  tool: PERMISSION.toolName,
  input: PERMISSION.input,
  riskClass: 'ask',
  // Both Servers drive a native-transport backend, so the prompt is stamped with the
  // native channel and survives the cutover unchanged (ADR 0014 D3).
  grantChannel: 'acp',
};
const RESULT: RunResult = { sessionId: SESSION_ID, exitCode: 0, stderr: '', aborted: false };

interface ControlledBackendConfig {
  sessionId: string;
  worktree: string;
  events: readonly AgentEvent[];
  permission: PermissionRequest;
  result: RunResult;
}

function controlledBackend(
  config: ControlledBackendConfig = {
    sessionId: SESSION_ID,
    worktree: WORKTREE,
    events: EVENTS,
    permission: PERMISSION,
    result: RESULT,
  },
): {
  backend: Backend;
  started: Promise<void>;
  steerSeen: SteerMessage[];
  permissionAnswers: PermissionDecision[];
  emitEvent(event: AgentEvent): Promise<void>;
  settle(): void;
} {
  const steerSeen: SteerMessage[] = [];
  const permissionAnswers: PermissionDecision[] = [];
  let resolveStarted!: () => void;
  let resolveResult!: (result: RunResult) => void;
  let rejectResult!: (error: unknown) => void;
  let runnerStore: RunTurnOptions['store'] | undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const result = new Promise<RunResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const backend: Backend = {
    // An attested native runner protocol, which is what puts the prompts this
    // fixture asserts on the native channel (ADR 0014 D3). Omitting it would fail
    // closed to `acp`, so it has to be declared rather than assumed.
    runnerSupervisorBackend: 'codex-acp',
    run(opts: RunTurnOptions): Promise<RunResult> {
      runnerStore = opts.store;
      opts.onSteer?.((message) => {
        steerSeen.push(message);
        return true;
      });
      void (async () => {
        await opts.store.createSession({
          sessionId: config.sessionId,
          worktree: config.worktree,
          model: 'm',
        });
        await opts.onSession?.(config.sessionId);
        for (const event of config.events) await opts.store.appendEvent(config.sessionId, event);
        opts.onPermissionRequest?.(config.permission, (decision) =>
          permissionAnswers.push(decision),
        );
        resolveStarted();
      })().catch(rejectResult);
      return result;
    },
  };
  return {
    backend,
    started,
    steerSeen,
    permissionAnswers,
    emitEvent: async (event: AgentEvent): Promise<void> => {
      if (runnerStore === undefined) throw new Error('Runner has not started');
      await runnerStore.appendEvent(config.sessionId, event);
    },
    settle: () => resolveResult(config.result),
  };
}

async function waitForChildReady(
  child: ChildProcessWithoutNullStreams,
  stderr: () => string,
): Promise<void> {
  await new Promise<void>((resolveReady, rejectReady) => {
    let stdout = '';
    const timeout = setTimeout(() => {
      cleanup();
      rejectReady(new Error(`Server A did not become ready: ${stderr()}`));
    }, 10_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onData = (chunk: Buffer): void => {
      stdout += chunk.toString('utf8');
      if (!stdout.split('\n').includes('READY')) return;
      cleanup();
      resolveReady();
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectReady(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      rejectReady(
        new Error(
          `Server A exited before ready (code=${String(code)}, signal=${String(signal)}): ${stderr()}`,
        ),
      );
    };
    child.stdout.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  stderr: () => string,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      rejectExit(
        new Error(
          `Server A did not exit (code=${String(child.exitCode)}, signal=${String(child.signalCode)}): ${stderr()}`,
        ),
      );
    }, 5_000);
    const onExit = (): void => {
      clearTimeout(timeout);
      resolveExit();
    };
    child.once('exit', onExit);
  });
}

describePostgres('two-Server Runner cutover (PostgreSQL + file/control transport)', () => {
  let dbA: Kysely<Database>;
  let dbB: Kysely<Database>;
  let observerDb: Kysely<Database>;
  let storeA: EventStore;
  let storeB: EventStore;
  let runtimeDir: string;

  beforeAll(async () => {
    dbA = createPostgresDb(connectionString!);
    dbB = createPostgresDb(connectionString!);
    observerDb = createPostgresDb(connectionString!);
    await migrateToLatest(observerDb);
    storeA = new EventStore(dbA);
    storeB = new EventStore(dbB);
    runtimeDir = await mkdtemp(join(tmpdir(), 'verity-two-server-cutover-'));
  });

  afterAll(async () => {
    await Promise.all([dbA.destroy(), dbB.destroy(), observerDb.destroy()]);
    await rm(runtimeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it('fences Server A, gives Server B control, and settles both tails exactly once', async () => {
    await storeA.createSession({ sessionId: SESSION_ID, worktree: WORKTREE, model: 'm' });
    await storeA.markTurnRunning({ sessionId: SESSION_ID, promptSeq: 1 });
    await storeA.bindTurnIdentity(SESSION_ID, {
      turnId: TURN_ID,
      startCommandId: 'postgres-two-server-cutover-start',
    });

    const eventFilePath = join(runtimeDir, 'events.jsonl');
    const controlSocketPath = join(runtimeDir, 'control.sock');
    const fixture = controlledBackend();
    const busA = new InMemoryEventBus();
    const busB = new InMemoryEventBus();
    const publishedA: SequencedEvent[] = [];
    const publishedB: SequencedEvent[] = [];
    busA.subscribe(SESSION_ID, (event) => publishedA.push(event));
    busB.subscribe(SESSION_ID, (event) => publishedB.push(event));

    const serverA = new FileTailRunnerClient(fixture.backend, {
      store: storeA,
      bus: busA,
      allocateEventFile: () => eventFilePath,
      allocateControlSocket: () => controlSocketPath,
      pollMs: 2,
    });
    const turnA = serverA.startTurn(
      {
        store: storeA,
        storeSessionId: SESSION_ID,
        worktree: WORKTREE,
        cwd: WORKTREE,
        turnId: TURN_ID,
      },
      {},
    );

    let turnBResult: Promise<RunResult> | undefined;
    try {
      await fixture.started;
      await vi.waitFor(async () => {
        const claims = await observerDb
          .selectFrom('runner_frames')
          .select('frame_seq')
          .where('turn_id', '=', TURN_ID)
          .execute();
        expect(claims).toHaveLength(4);
      });
      await expect(turnA.steer({ text: 'owned by A' })).resolves.toBe(true);

      const resurfaced: PermissionRequest[] = [];
      const serverB = new FileTailRunnerClient(fixture.backend, {
        store: storeB,
        bus: busB,
        allocateEventFile: () => join(runtimeDir, 'unused.jsonl'),
        pollMs: 2,
      });
      const turnB = serverB.attach(
        {
          turnId: TURN_ID,
          sessionId: SESSION_ID,
          eventFilePath,
          controlSocketPath,
        },
        { onPermissionRequest: (request) => resurfaced.push(request) },
      );
      turnBResult = turnB.result;

      await vi.waitFor(() => expect(resurfaced).toEqual([PERMISSION]));
      await expect(turnB.steer({ text: 'owned by B' })).resolves.toBe(true);
      await expect(turnA.steer({ text: 'stale A command' })).rejects.toMatchObject({
        reason: 'stale-lease',
      });
      await expect(
        turnA.answerPermission(PERMISSION.toolUseId, { behavior: 'deny', message: 'stale' }),
      ).resolves.toBe(false);
      expect(fixture.permissionAnswers).toEqual([]);
      await expect(
        turnB.answerPermission(PERMISSION.toolUseId, { behavior: 'allow' }),
      ).resolves.toBe(true);
      expect(fixture.steerSeen).toEqual([{ text: 'owned by A' }, { text: 'owned by B' }]);
      expect(fixture.permissionAnswers).toEqual([{ behavior: 'allow' }]);

      fixture.settle();
      await expect(Promise.all([turnA.result, turnB.result])).resolves.toEqual([RESULT, RESULT]);

      expect(publishedA.map((event) => event.event)).toEqual([...EVENTS, PERMISSION_EVENT]);
      expect(publishedB).toEqual([]);
      expect(await storeB.getEvents(SESSION_ID)).toEqual([...EVENTS, PERMISSION_EVENT]);
      expect((await storeB.listRunningTurns()).filter((row) => row.turnId === TURN_ID)).toEqual([]);
      const claims = await observerDb
        .selectFrom('runner_frames')
        .select(['frame_seq', 'terminal'])
        .where('turn_id', '=', TURN_ID)
        .orderBy('frame_seq', 'asc')
        .execute();
      expect(claims.map((row) => ({ ...row, frame_seq: Number(row.frame_seq) }))).toEqual([
        { frame_seq: 1, terminal: false },
        { frame_seq: 2, terminal: false },
        { frame_seq: 3, terminal: false },
        { frame_seq: 4, terminal: false },
        { frame_seq: 5, terminal: true },
      ]);
    } finally {
      fixture.settle();
      await Promise.allSettled([turnA.result, ...(turnBResult === undefined ? [] : [turnBResult])]);
    }
  });

  it('reattaches after a real Server A SIGKILL while the Runner stays live', async () => {
    const sessionId = 'postgres-process-sigkill-session';
    const turnId = 'postgres-process-sigkill-turn';
    const worktree = '/wt/postgres-process-sigkill';
    const events: readonly AgentEvent[] = [
      { t: 'text', delta: 'worker output before SIGKILL' },
      { t: 'text', delta: 'worker output survives SIGKILL' },
    ];
    const offlineEvent: AgentEvent = { t: 'text', delta: 'emitted while both Servers are offline' };
    const permission: PermissionRequest = {
      requestId: 'process-sigkill-permission',
      toolName: 'Bash',
      input: { command: 'printf survived' },
      toolUseId: 'process-sigkill-tool',
    };
    const result: RunResult = { sessionId, exitCode: 0, stderr: '', aborted: false };
    const fixture = controlledBackend({ sessionId, worktree, events, permission, result });
    await storeA.createSession({ sessionId, worktree, model: 'm' });
    await storeA.markTurnRunning({ sessionId, promptSeq: 1 });
    await storeA.bindTurnIdentity(sessionId, {
      turnId,
      startCommandId: 'postgres-process-sigkill-start',
    });

    const processRuntimeDir = join(runtimeDir, 'process-sigkill');
    const eventFilePath = join(processRuntimeDir, 'events.jsonl');
    const controlSocketPath = join(processRuntimeDir, 'control.sock');
    const runner = new RunnerServer(fixture.backend);
    const runnerTurn = await runner.run(eventFilePath, {
      worktree,
      cwd: worktree,
      turnId,
      controlSocketPath,
    });
    await fixture.started;

    const sessionModuleUrl = pathToFileURL(resolve('packages/session/dist/index.js')).href;
    const storeModuleUrl = pathToFileURL(resolve('packages/store/dist/index.js')).href;
    const serverAScript = `
      import { FileTailRunnerClient, InMemoryEventBus } from ${JSON.stringify(sessionModuleUrl)};
      import { createPostgresDb, EventStore } from ${JSON.stringify(storeModuleUrl)};
      const db = createPostgresDb(process.env.VERITY_TEST_POSTGRES_URL);
      const store = new EventStore(db);
      // The reattaching Server resolves the same backend it would have launched, so it
      // declares the same attested runner protocol (ADR 0014 D3). Without it the
      // channel fails closed to \`acp\` and the permission this test persists would be
      // stamped for a transport it never arrived on.
      const backend = {
        runnerSupervisorBackend: 'codex-acp',
        run: () => Promise.reject(new Error('attach must not launch backend')),
      };
      const client = new FileTailRunnerClient(backend, {
        store,
        bus: new InMemoryEventBus(),
        allocateEventFile: () => process.env.CUTOVER_EVENT_FILE + '.unused',
        pollMs: 2,
      });
      const turn = client.attach({
        turnId: process.env.CUTOVER_TURN_ID,
        sessionId: process.env.CUTOVER_SESSION_ID,
        eventFilePath: process.env.CUTOVER_EVENT_FILE,
        controlSocketPath: process.env.CUTOVER_CONTROL_SOCKET,
      }, {});
      if (!(await turn.steer({ text: 'owned by process A' }))) {
        throw new Error('Server A failed to acquire control');
      }
      process.stdout.write('READY\\n');
      await turn.result;
      await db.destroy();
    `;
    let childStderr = '';
    const serverAProcess = spawn(
      process.execPath,
      ['--input-type=module', '--eval', serverAScript],
      {
        cwd: resolve('.'),
        env: {
          PATH: process.env.PATH,
          VERITY_TEST_POSTGRES_URL: connectionString!,
          CUTOVER_SESSION_ID: sessionId,
          CUTOVER_TURN_ID: turnId,
          CUTOVER_EVENT_FILE: eventFilePath,
          CUTOVER_CONTROL_SOCKET: controlSocketPath,
        },
        stdio: 'pipe',
      },
    );
    serverAProcess.stdin.end();
    serverAProcess.stderr.on('data', (chunk: Buffer) => {
      childStderr = `${childStderr}${chunk.toString('utf8')}`.slice(-16_384);
    });

    let turnBResult: Promise<RunResult> | undefined;
    try {
      await waitForChildReady(serverAProcess, () => childStderr);
      await vi.waitFor(async () => {
        const claims = await observerDb
          .selectFrom('runner_frames')
          .select('frame_seq')
          .where('turn_id', '=', turnId)
          .execute();
        expect(claims).toHaveLength(4);
      });
      expect(fixture.steerSeen).toEqual([{ text: 'owned by process A' }]);

      serverAProcess.kill('SIGKILL');
      await waitForChildExit(serverAProcess, () => childStderr);
      expect(serverAProcess.signalCode).toBe('SIGKILL');
      await fixture.emitEvent(offlineEvent);

      const publishedB: SequencedEvent[] = [];
      const busB = new InMemoryEventBus();
      busB.subscribe(sessionId, (event) => publishedB.push(event));
      const resurfaced: PermissionRequest[] = [];
      const serverB = new FileTailRunnerClient(fixture.backend, {
        store: storeB,
        bus: busB,
        allocateEventFile: () => join(processRuntimeDir, 'unused.jsonl'),
        pollMs: 2,
      });
      const turnB = serverB.attach(
        { turnId, sessionId, eventFilePath, controlSocketPath },
        { onPermissionRequest: (request) => resurfaced.push(request) },
      );
      turnBResult = turnB.result;

      await vi.waitFor(() => expect(resurfaced).toEqual([permission]));
      await expect(turnB.steer({ text: 'owned by process B' })).resolves.toBe(true);
      await expect(
        turnB.answerPermission(permission.toolUseId, { behavior: 'allow' }),
      ).resolves.toBe(true);
      expect(fixture.steerSeen).toEqual([
        { text: 'owned by process A' },
        { text: 'owned by process B' },
      ]);
      expect(fixture.permissionAnswers).toEqual([{ behavior: 'allow' }]);

      fixture.settle();
      await expect(Promise.all([runnerTurn.result, turnB.result])).resolves.toEqual([
        result,
        result,
      ]);
      expect(publishedB.map((event) => event.event)).toEqual([offlineEvent]);
      expect(await storeB.getEvents(sessionId)).toEqual([
        ...events,
        {
          t: 'permission',
          id: permission.toolUseId,
          tool: permission.toolName,
          input: permission.input,
          riskClass: 'ask',
          grantChannel: 'acp',
        },
        offlineEvent,
      ]);
      expect((await storeB.listRunningTurns()).filter((row) => row.turnId === turnId)).toEqual([]);
      const claims = await observerDb
        .selectFrom('runner_frames')
        .select(['frame_seq', 'terminal'])
        .where('turn_id', '=', turnId)
        .orderBy('frame_seq', 'asc')
        .execute();
      expect(claims.map((row) => ({ ...row, frame_seq: Number(row.frame_seq) }))).toEqual([
        { frame_seq: 1, terminal: false },
        { frame_seq: 2, terminal: false },
        { frame_seq: 3, terminal: false },
        { frame_seq: 4, terminal: false },
        { frame_seq: 5, terminal: false },
        { frame_seq: 6, terminal: true },
      ]);
    } finally {
      if (serverAProcess.exitCode === null && serverAProcess.signalCode === null) {
        serverAProcess.kill('SIGKILL');
      }
      fixture.settle();
      await Promise.allSettled([
        waitForChildExit(serverAProcess, () => childStderr),
        runnerTurn.result,
        ...(turnBResult === undefined ? [] : [turnBResult]),
      ]);
    }
  });
});
