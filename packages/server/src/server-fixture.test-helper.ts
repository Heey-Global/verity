import {
  BREVITY_SYSTEM_PROMPT,
  CHOICES_SYSTEM_PROMPT,
  DELEGATION_SYSTEM_PROMPT,
  TERMINOLOGY_SYSTEM_PROMPT,
  type Attachment,
} from '@verity/events';
import type { Conductor, StartOptions } from '@verity/session';
import { InMemoryEventBus } from '@verity/session';
import { type ProjectRecord } from '@verity/store';
import { createIsolatedTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, vi } from 'vitest';
import { createAuthTokenRegistry } from './auth.js';
import { type GitOutput } from './branches.js';
import type { SandboxUpdateChecker, SandboxUpdateStatus } from './sandbox-updates.js';
import { SERVER_COMPAT } from './self-update/compat.js';
import {
  OFFICIAL_AGENT_SEED_IMAGE,
  RELEASE_CHANNEL_SCHEMA_VERSION,
  type ReleaseChannelMetadata,
  type ServerUpdateAvailability,
} from './self-update/release-channel.js';
import type { UpdateOperation } from './self-update/update-operation.js';
import { buildServer, CLAUDE_MODELS, sortModelIds } from './server.js';

// The expected Claude portion of the /models list, derived from the single CLAUDE_MODELS
// source via the SAME comparator the route uses (sortModelIds) — so adding a model touches
// one place (that source + the guard test below), not every route assertion, and the
// expected order can never drift from the route's actual sort. NOTE: the merge assertions
// below spread `[...CLAUDE_SORTED, <provider ids>]`, which assumes every `claude-*` id sorts
// before the currently-configured `codex/*` / `deepinfra/*` prefixes (true today). A future
// provider prefix that sorts before `claude-` (e.g. `cerebras/`) would interleave and those
// expectations would need rebuilding via `sortModelIds([...CLAUDE_MODELS, ...providerIds])`.
export const CLAUDE_SORTED = sortModelIds(CLAUDE_MODELS);

export let ctx: TestDb;

export let bus: InMemoryEventBus;

export let app: FastifyInstance;

export let port: number;

export let worktreeRoot: string;

export const repeatedVerityInstructions = `${TERMINOLOGY_SYSTEM_PROMPT}

${CHOICES_SYSTEM_PROMPT}

${DELEGATION_SYSTEM_PROMPT}

${BREVITY_SYSTEM_PROMPT}`;

// The server's job on the turn/create routes is HTTP→conductor mapping; the
// conductor's own behaviour is covered in @verity/session. Stub it so the status
// mapping (201/202/404/409/410/429/400) is tested deterministically without a process.
export const dispatchTurn =
  vi.fn<
    (
      id: string,
      prompt: string,
      opts?: unknown,
      dispatchOpts?: unknown,
    ) => Promise<{ queued: boolean }>
  >();

export const dispatchTurnWhenIdle =
  vi.fn<
    (
      id: string,
      prompt: string,
      opts?: unknown,
      dispatchOpts?: unknown,
    ) => Promise<{ accepted: boolean }>
  >();

export const sendTurn = vi.fn<() => Promise<{ exitCode: number; aborted: boolean }>>();

export const startSession = vi.fn<(opts: StartOptions) => Promise<{ sessionId: string }>>();

export const isBusy = vi.fn<(id: string) => boolean>(() => false);

export const queuedItems = vi.fn<
  (id: string) => { id: string; text: string; attachments?: Attachment[] }[]
>(() => []);

export const dequeue =
  vi.fn<(id: string, itemId: string) => Promise<{ prompt: string } | undefined>>();

export const clearQueue = vi.fn<(id: string) => Promise<{ id: string; prompt: string }[]>>(
  async () => [],
);

export const cancelTurn = vi.fn<(id: string) => boolean>(() => false);

export const stopSession = vi.fn<
  (id: string) => Promise<{ cancelled: boolean; droppedQueued: { id: string; prompt: string }[] }>
>(async (id) => {
  const droppedQueued = await clearQueue(id);
  const cancelled = cancelTurn(id);
  return { cancelled, droppedQueued };
});

export const decidePermission = vi.fn<
  (id: string, toolUseId: string, decision: unknown) => boolean
>(() => false);

export const recover = vi.fn<() => Promise<void>>(async () => undefined);

export const emitMerged = vi.fn<(id: string, number: number) => Promise<void>>(
  async () => undefined,
);

export const closeSession = vi.fn<(id: string) => void>();

export const runAfterCurrentTurn = vi.fn<(id: string, fn: () => void) => boolean>((id, fn) => {
  if (isBusy(id)) return true;
  fn();
  return false;
});

export const hasDeferredAfterCurrentTurn = vi.fn<(id: string) => boolean>(() => false);

export const isBackendHandoffPending = vi.fn<(id: string) => boolean>(() => false);

export const hasUnconfirmedTermination = vi.fn<(id: string) => boolean>(() => false);

export const releaseUnconfirmedTermination = vi.fn<(id: string) => Promise<boolean>>(
  async () => false,
);

// Stand-in for the ownership barrier: run the swap under the session fence. The real
// one additionally cancels any in-flight turn and refuses (throws
// BackendTerminationUnconfirmedError) unless the fence drops — i.e. unless the old
// worker is provably gone. That is conductor state, so it is unit-tested against a live
// Conductor in conductor.test.ts; asserting it through this double would only test the
// double. What the route owes is here: everything that mutates model/backend state must
// happen INSIDE the callback, and a rejection must leave the session untouched.
export const runBackendHandoff = vi.fn(
  async <T>(_id: string, fn: () => Promise<T>): Promise<T> => await fn(),
);

export const pendingPermissions = vi.fn<(id: string) => string[]>(() => []);

// Faithful stand-in for the real runWhenIdle: run the action NOW when idle, DEFER it
// (don't run it) when a turn is in flight. The real deferred-then-settle execution is
// unit-tested against a live Conductor in conductor.test.ts.
export const runWhenIdle = vi.fn<(id: string, fn: () => Promise<void>) => Promise<void>>(
  async (id, fn) => {
    if (!isBusy(id)) await fn();
  },
);

// Same admission rule as runWhenIdle; the real one additionally holds the turn lock
// across the callback, which is unit-tested against a live Conductor.
export const runExclusive = vi.fn<(id: string, fn: () => Promise<void>) => Promise<void>>(
  async (id, fn) => {
    if (!isBusy(id)) await fn();
  },
);

// Stand-in for the non-deferring variant: busy → refuse, idle → run under the lock.
export const tryRunExclusive = vi.fn<
  (
    id: string,
    fn: () => Promise<unknown>,
  ) => Promise<{ ran: true; value: unknown } | { ran: false }>
>(async (id, fn) => (isBusy(id) ? { ran: false } : { ran: true, value: await fn() }));

export const conductor = {
  sendTurn,
  dispatchTurn,
  dispatchTurnWhenIdle,
  startSession,
  isBusy,
  queuedItems,
  dequeue,
  clearQueue,
  cancelTurn,
  stopSession,
  decidePermission,
  recover,
  emitMerged,
  closeSession,
  runAfterCurrentTurn,
  hasDeferredAfterCurrentTurn,
  isBackendHandoffPending,
  hasUnconfirmedTermination,
  releaseUnconfirmedTermination,
  runBackendHandoff,
  pendingPermissions,
  runWhenIdle,
  runExclusive,
  tryRunExclusive,
} as unknown as Conductor;

// Branch service (#91) stub — the git ops are unit-tested in branches.test.ts;
// here we only verify the route's HTTP mapping.
export const branchSvc = {
  hasProjectChanges: vi.fn<(wt: string, base: string) => Promise<boolean>>(),
  current: vi.fn<(wt: string) => Promise<string>>(),
  sessionBranches: vi.fn<(wt: string) => Promise<string[]>>(),
  switchable: vi.fn<(wt: string) => Promise<string[]>>(),
  previewable: vi.fn<(wt: string) => Promise<string[]>>(),
  switch: vi.fn<(wt: string, opts: unknown) => Promise<string>>(),
  autoRename: vi.fn<(wt: string, candidate: string) => Promise<string | null>>(),
  resetToMergedBase: vi.fn<(wt: string) => Promise<{ base: string; deletedBranch?: string }>>(),
  mergeIntoLocalBase:
    vi.fn<
      (
        wt: string,
        basePath: string,
        opts: { git: GitOutput },
      ) => Promise<{ base: string; branch: string; mergedTip: string; baseTip: string }>
    >(),
  resetToLocalBase: vi.fn<
    (
      wt: string,
      base: string,
      merged: { branch: string; mergedTip: string; baseTip: string },
      opts: { git: GitOutput },
    ) => Promise<{
      base: string;
      deletedBranch?: string;
      retainedBranch?: string;
      skipped?: true;
    }>
  >(),
};

export const agentLogin = {
  start: vi.fn(),
  get: vi.fn(),
  submitCode: vi.fn(),
  close: vi.fn(),
};

export const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  turns: 0,
};

export async function createExistingSession(sessionId = 's1'): Promise<string> {
  const worktree = mkdtempSync(join(worktreeRoot, `${sessionId}-`));
  await ctx.store.createSession({ sessionId, worktree, model: 'm' });
  return worktree;
}

// Isolated (in-process pglite), not the shared PostgreSQL harness: the scheduler
// tests drive store-backed work under vi.useFakeTimers(), and
// advanceTimersByTimeAsync only flushes microtasks — it cannot await a TCP round
// trip, so a networked database leaves the assertion running before the tick's
// query has come back. The live server's background work also races truncateAll
// between tests. See packages/store/src/testing.ts; the pairing is enforced by
// scripts/test-db-harness.test.ts.
beforeAll(async () => {
  ctx = await createIsolatedTestDb();
  bus = new InMemoryEventBus();
  worktreeRoot = mkdtempSync(join(tmpdir(), 'verity-srv-test-'));
  app = buildServer({
    eventStore: ctx.store,
    bus,
    conductor,
    agentLogin,
    spawnWorktreeRoot: worktreeRoot,
    projectCloneRoot: tmpdir(),
    branches: branchSvc as unknown as NonNullable<Parameters<typeof buildServer>[0]['branches']>,
    // This instance is shared by every test in the file and the branch cache is
    // keyed by worktree, which the tests reuse — a cached label would leak from
    // one test's git mock into the next. The cache's own behavior is covered by
    // its own server instance below.
    branchCacheTtlMs: 0,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await app.close();
  await ctx.close();
  rmSync(worktreeRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  dispatchTurn.mockReset();
  dispatchTurnWhenIdle.mockReset();
  dispatchTurnWhenIdle.mockResolvedValue({ accepted: true });
  sendTurn.mockReset();
  sendTurn.mockResolvedValue({ exitCode: 0, aborted: false });
  dispatchTurn.mockResolvedValue({ queued: false });
  startSession.mockReset();
  startSession.mockResolvedValue({ sessionId: 'backend-session' });
  isBusy.mockReset();
  isBusy.mockReturnValue(false);
  queuedItems.mockReset();
  queuedItems.mockReturnValue([]);
  dequeue.mockReset();
  clearQueue.mockReset();
  clearQueue.mockResolvedValue([]);
  stopSession.mockReset();
  stopSession.mockImplementation(async (id) => {
    const droppedQueued = await clearQueue(id);
    const cancelled = cancelTurn(id);
    return { cancelled, droppedQueued };
  });
  cancelTurn.mockReset();
  cancelTurn.mockReturnValue(false);
  decidePermission.mockReset();
  decidePermission.mockReturnValue(false);
  recover.mockReset();
  recover.mockResolvedValue(undefined);
  emitMerged.mockReset();
  emitMerged.mockResolvedValue(undefined);
  closeSession.mockReset();
  runAfterCurrentTurn.mockReset();
  runAfterCurrentTurn.mockImplementation((id, fn) => {
    if (isBusy(id)) return true;
    fn();
    return false;
  });
  hasDeferredAfterCurrentTurn.mockReset();
  hasDeferredAfterCurrentTurn.mockReturnValue(false);
  isBackendHandoffPending.mockReset();
  isBackendHandoffPending.mockReturnValue(false);
  hasUnconfirmedTermination.mockReset();
  hasUnconfirmedTermination.mockReturnValue(false);
  releaseUnconfirmedTermination.mockReset();
  releaseUnconfirmedTermination.mockResolvedValue(false);
  runBackendHandoff.mockReset();
  runBackendHandoff.mockImplementation(async (_id, fn) => await fn());
  pendingPermissions.mockReset();
  pendingPermissions.mockReturnValue([]);
  runWhenIdle.mockReset();
  runWhenIdle.mockImplementation(async (id, fn) => {
    if (!isBusy(id)) await fn();
  });
  runExclusive.mockReset();
  runExclusive.mockImplementation(async (id, fn) => {
    if (!isBusy(id)) await fn();
  });
  tryRunExclusive.mockReset();
  tryRunExclusive.mockImplementation(async (id, fn) =>
    isBusy(id) ? { ran: false } : { ran: true, value: await fn() },
  );
  agentLogin.start.mockReset();
  agentLogin.get.mockReset();
  agentLogin.submitCode.mockReset();
  agentLogin.close.mockReset();
  branchSvc.current.mockReset();
  branchSvc.switchable.mockReset();
  branchSvc.previewable.mockReset();
  branchSvc.previewable.mockResolvedValue([]);
  branchSvc.switch.mockReset();
  branchSvc.resetToMergedBase.mockReset();
  branchSvc.resetToMergedBase.mockResolvedValue({ base: 'main' });
  branchSvc.mergeIntoLocalBase.mockReset();
  branchSvc.mergeIntoLocalBase.mockResolvedValue({
    base: 'main',
    branch: 'feat/thing',
    mergedTip: 'abc1234',
    baseTip: 'merge123',
  });
  branchSvc.resetToLocalBase.mockReset();
  branchSvc.resetToLocalBase.mockResolvedValue({ base: 'main', deletedBranch: 'feat/thing' });
});

export const AVAILABLE_SANDBOX_UPDATE: SandboxUpdateStatus = {
  state: 'available',
  kind: 'normal',
  category: 'software',
  reason: 'test',
  current: 'old',
  currentVersion: null,
  currentRevision: null,
  target: 'new',
  targetVersion: null,
  targetRevision: null,
  selfRepair: 'converging',
  turnBlocked: false,
};

/**
 * A checker that reports the same available normal update for every project.
 *
 * `satisfies` rather than an annotation, so the spies stay visible as spies: a
 * `SandboxUpdateChecker`-typed value hands back method signatures, which cannot
 * be asserted on without tripping `unbound-method`.
 */
export function availableSandboxUpdates() {
  return {
    status: vi.fn(async () => AVAILABLE_SANDBOX_UPDATE),
    statusAll: vi.fn(
      async (projects: readonly ProjectRecord[]) =>
        new Map(projects.map((project) => [project.id, AVAILABLE_SANDBOX_UPDATE])),
    ),
  } satisfies SandboxUpdateChecker;
}

export const availableDigest = `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`;

export const availableRelease: ReleaseChannelMetadata = {
  schemaVersion: RELEASE_CHANNEL_SCHEMA_VERSION,
  channel: 'stable',
  version: '1.4.0',
  revision: 'e'.repeat(40),
  architecture: 'amd64',
  serverImage: availableDigest,
  agentSeedImage: `${OFFICIAL_AGENT_SEED_IMAGE}@sha256:${'d'.repeat(64)}`,
  compatibility: SERVER_COMPAT,
  publishedAt: '2026-08-10T00:00:00.000Z',
  generation: '2026-08-10T00:00:00.000Z',
};

export const preparingOperation: UpdateOperation = {
  updateId: 'update-1',
  state: 'preparing',
  phase: 'requested',
  step: 1,
  totalSteps: 14,
  generation: 3,
  previousDigest: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
  targetDigest: availableDigest,
  failureCode: null,
  startedAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
};

/**
 * A managed deployment whose release channel and privileged Updater are both
 * stubbed, so the route's own authorization and digest rules are what is
 * actually under test.
 */
export async function updateFixture(
  options: {
    authEnabled?: boolean;
    availability?: ServerUpdateAvailability;
    operation?: UpdateOperation | null;
    readOperation?: () => Promise<UpdateOperation | null>;
    requestUpdate?: () => Promise<UpdateOperation>;
  } = {},
) {
  const enabled = options.authEnabled ?? true;
  const registry = await createAuthTokenRegistry(ctx.store, { enabled });
  const token = enabled ? (await registry.mint('update-device')).token : '';
  const requested: { idempotencyKey: string; targetDigest: string }[] = [];
  const availability: ServerUpdateAvailability = options.availability ?? {
    state: 'available',
    release: availableRelease,
    operation: null,
  };
  const deps = {
    eventStore: ctx.store,
    bus: new InMemoryEventBus(),
    conductor,
    authRegistry: registry,
    serverUpdateResolver: { resolve: async (): Promise<ServerUpdateAvailability> => availability },
    serverUpdateController: {
      readOperation: options.readOperation ?? (async () => options.operation ?? null),
      requestUpdate: async (input: {
        readonly idempotencyKey: string;
        readonly targetDigest: string;
      }) => {
        if (options.requestUpdate !== undefined) return options.requestUpdate();
        requested.push({ ...input });
        return preparingOperation;
      },
    },
  };
  return { deps, requested, token };
}
