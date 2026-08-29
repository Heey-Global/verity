import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { createServer } from 'node:net';
import { open, readdir, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

export const UPDATE_JOURNAL_SCHEMA_VERSION = 2 as const;
export const UPDATE_JOURNAL_FILE = 'update-journal.json';

export type PreparationPhase =
  | 'requested'
  | 'pulling'
  | 'verifying-image'
  | 'preflight'
  | 'creating-standby'
  | 'standby'
  | 'failed';

export type CutoverPhase =
  | 'standby'
  | 'quiescing-old'
  | 'handing-off-key'
  | 'activating-candidate'
  | 'checking-candidate'
  | 'draining-gateway'
  | 'switching-gateway'
  | 'observing-candidate'
  | 'committed'
  | 'reconciling-companions'
  | 'completed'
  | 'rollback-quiescing-candidate'
  | 'rollback-activating-old'
  | 'rollback-switching-gateway'
  | 'rolled-back';

export type UpdatePhase = PreparationPhase | CutoverPhase;

export interface UpdateJournalBody {
  readonly schemaVersion: typeof UPDATE_JOURNAL_SCHEMA_VERSION;
  readonly deploymentId: string;
  readonly updateId: string;
  readonly idempotencyKey: string;
  readonly generation: number;
  readonly previousDigest: string;
  readonly targetDigest: string;
  readonly phase: UpdatePhase;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly candidate: null | {
    readonly containerId: string;
    readonly containerName: string;
  };
  readonly previousContainerId: string | null;
  readonly failure: null | { readonly code: string };
}

export interface UpdateJournal extends UpdateJournalBody {
  readonly checksum: string;
}

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/;
const IMAGE = /^ghcr\.io\/heey-global\/verity\/verity-server@sha256:[a-f0-9]{64}$/;
const CONTAINER_ID = /^[a-f0-9]{12,64}$/;
const PHASES: readonly UpdatePhase[] = [
  'requested',
  'pulling',
  'verifying-image',
  'preflight',
  'creating-standby',
  'standby',
  'failed',
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
];
const NEXT: Readonly<Record<Exclude<PreparationPhase, 'failed'>, PreparationPhase | null>> = {
  requested: 'pulling',
  pulling: 'verifying-image',
  'verifying-image': 'preflight',
  preflight: 'creating-standby',
  'creating-standby': 'standby',
  standby: null,
};

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function checksum(body: UpdateJournalBody): string {
  const canonical: UpdateJournalBody = {
    schemaVersion: body.schemaVersion,
    deploymentId: body.deploymentId,
    updateId: body.updateId,
    idempotencyKey: body.idempotencyKey,
    generation: body.generation,
    previousDigest: body.previousDigest,
    targetDigest: body.targetDigest,
    phase: body.phase,
    createdAt: body.createdAt,
    updatedAt: body.updatedAt,
    candidate: body.candidate,
    previousContainerId: body.previousContainerId,
    failure: body.failure,
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

function seal(body: UpdateJournalBody): UpdateJournal {
  return { ...body, checksum: checksum(body) };
}

function bodyOf(journal: UpdateJournal): UpdateJournalBody {
  return {
    schemaVersion: journal.schemaVersion,
    deploymentId: journal.deploymentId,
    updateId: journal.updateId,
    idempotencyKey: journal.idempotencyKey,
    generation: journal.generation,
    previousDigest: journal.previousDigest,
    targetDigest: journal.targetDigest,
    phase: journal.phase,
    createdAt: journal.createdAt,
    updatedAt: journal.updatedAt,
    candidate: journal.candidate,
    previousContainerId: journal.previousContainerId,
    failure: journal.failure,
  };
}

function validTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export function parseUpdateJournal(value: unknown): UpdateJournal | null {
  if (object(value) && value.schemaVersion === 1) {
    const legacyKeys = [
      'schemaVersion',
      'deploymentId',
      'updateId',
      'idempotencyKey',
      'generation',
      'previousDigest',
      'targetDigest',
      'phase',
      'createdAt',
      'updatedAt',
      'candidate',
      'failure',
      'checksum',
    ] as const;
    if (!exact(value, legacyKeys) || typeof value.checksum !== 'string') return null;
    const legacyBody = {
      schemaVersion: 1,
      deploymentId: value.deploymentId,
      updateId: value.updateId,
      idempotencyKey: value.idempotencyKey,
      generation: value.generation,
      previousDigest: value.previousDigest,
      targetDigest: value.targetDigest,
      phase: value.phase,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      candidate: value.candidate,
      failure: value.failure,
    };
    const legacyChecksum = `sha256:${createHash('sha256').update(JSON.stringify(legacyBody)).digest('hex')}`;
    if (value.checksum !== legacyChecksum) return null;
    return parseUpdateJournal(
      seal({
        ...(legacyBody as Omit<UpdateJournalBody, 'schemaVersion' | 'previousContainerId'>),
        schemaVersion: 2,
        previousContainerId: null,
      }),
    );
  }
  if (
    !object(value) ||
    !exact(value, [
      'schemaVersion',
      'deploymentId',
      'updateId',
      'idempotencyKey',
      'generation',
      'previousDigest',
      'targetDigest',
      'phase',
      'createdAt',
      'updatedAt',
      'candidate',
      'previousContainerId',
      'failure',
      'checksum',
    ]) ||
    value.schemaVersion !== UPDATE_JOURNAL_SCHEMA_VERSION ||
    typeof value.deploymentId !== 'string' ||
    !IDENTIFIER.test(value.deploymentId) ||
    typeof value.updateId !== 'string' ||
    !IDENTIFIER.test(value.updateId) ||
    typeof value.idempotencyKey !== 'string' ||
    !IDENTIFIER.test(value.idempotencyKey) ||
    typeof value.generation !== 'number' ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    typeof value.previousDigest !== 'string' ||
    !IMAGE.test(value.previousDigest) ||
    typeof value.targetDigest !== 'string' ||
    !IMAGE.test(value.targetDigest) ||
    typeof value.phase !== 'string' ||
    !PHASES.includes(value.phase as UpdatePhase) ||
    !validTime(value.createdAt) ||
    !validTime(value.updatedAt) ||
    value.updatedAt < value.createdAt ||
    typeof value.checksum !== 'string'
  )
    return null;
  let candidate: UpdateJournalBody['candidate'];
  if (value.candidate === null) candidate = null;
  else if (
    object(value.candidate) &&
    exact(value.candidate, ['containerId', 'containerName']) &&
    typeof value.candidate.containerId === 'string' &&
    CONTAINER_ID.test(value.candidate.containerId) &&
    typeof value.candidate.containerName === 'string' &&
    IDENTIFIER.test(value.candidate.containerName)
  )
    candidate = {
      containerId: value.candidate.containerId,
      containerName: value.candidate.containerName,
    };
  else return null;
  const previousContainerId =
    value.previousContainerId === null
      ? null
      : typeof value.previousContainerId === 'string' &&
          CONTAINER_ID.test(value.previousContainerId)
        ? value.previousContainerId
        : undefined;
  if (previousContainerId === undefined) return null;
  let failure: UpdateJournalBody['failure'];
  if (value.failure === null) failure = null;
  else if (
    object(value.failure) &&
    exact(value.failure, ['code']) &&
    typeof value.failure.code === 'string' &&
    IDENTIFIER.test(value.failure.code)
  )
    failure = { code: value.failure.code };
  else return null;
  if (
    (value.phase === 'standby' ||
      (typeof value.phase === 'string' &&
        ![
          'requested',
          'pulling',
          'verifying-image',
          'preflight',
          'creating-standby',
          'failed',
        ].includes(value.phase))) !==
    (candidate !== null)
  )
    return null;
  const cutover = ![
    'requested',
    'pulling',
    'verifying-image',
    'preflight',
    'creating-standby',
    'standby',
    'failed',
  ].includes(value.phase);
  if (cutover !== (previousContainerId !== null)) return null;
  if ((value.phase === 'failed') !== (failure !== null)) return null;
  const body: UpdateJournalBody = {
    schemaVersion: 2,
    deploymentId: value.deploymentId,
    updateId: value.updateId,
    idempotencyKey: value.idempotencyKey,
    generation: value.generation,
    previousDigest: value.previousDigest,
    targetDigest: value.targetDigest,
    phase: value.phase as UpdatePhase,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    candidate,
    previousContainerId,
    failure,
  };
  return value.checksum === checksum(body) ? { ...body, checksum: value.checksum } : null;
}

async function openRoot(root: string): Promise<FileHandle> {
  const directory = await open(root, 'r');
  const metadata = await directory.stat();
  const effectiveUid = process.geteuid?.();
  if (
    (await realpath(`/proc/self/fd/${directory.fd}`)) !== root ||
    !metadata.isDirectory() ||
    effectiveUid === undefined ||
    metadata.uid !== effectiveUid ||
    (metadata.mode & 0o077) !== 0
  ) {
    await directory.close();
    throw new Error('update journal root must be a private updater-owned directory');
  }
  return directory;
}

async function readPinned(root: string): Promise<UpdateJournal | null> {
  let file: FileHandle;
  try {
    file = await open(join(root, UPDATE_JOURNAL_FILE), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const metadata = await file.stat();
    const effectiveUid = process.geteuid?.();
    if (
      !metadata.isFile() ||
      effectiveUid === undefined ||
      metadata.uid !== effectiveUid ||
      (metadata.mode & 0o177) !== 0
    )
      throw new Error('update journal must be a private updater-owned regular file');
    const parsed = parseUpdateJournal(JSON.parse(await file.readFile('utf8')));
    if (parsed === null) throw new Error('update journal is corrupt');
    return parsed;
  } finally {
    await file.close();
  }
}

/** Hold a crash-released, host-wide single-writer lease for one journal root. */
export async function withUpdateJournalLease<T>(root: string, run: () => Promise<T>): Promise<T> {
  const identity = createHash('sha256')
    .update(await realpath(root))
    .digest('hex');
  const server = createServer();
  const socket = `\0verity-update-journal-${identity}`;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, () => {
      server.off('error', reject);
      resolve();
    });
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE')
      throw new Error('another updater process owns the update journal', { cause: error });
    throw error;
  });
  try {
    return await run();
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
}

async function syncDirectory(root: string): Promise<void> {
  const directory = await open(root, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function replacePinned(root: string, journal: UpdateJournal): Promise<void> {
  const temporary = join(root, `.update-journal-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(journal, null, 2)}\n`, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, join(root, UPDATE_JOURNAL_FILE));
    await syncDirectory(root);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function createPinned(root: string, journal: UpdateJournal): Promise<void> {
  const file = await open(join(root, UPDATE_JOURNAL_FILE), 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(journal, null, 2)}\n`, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(root);
}

export async function readUpdateJournal(root: string): Promise<UpdateJournal | null> {
  const directory = await openRoot(root);
  try {
    return await readPinned(`/proc/self/fd/${directory.fd}`);
  } finally {
    await directory.close();
  }
}

export interface BeginUpdateOptions {
  readonly root: string;
  readonly deploymentId: string;
  readonly idempotencyKey: string;
  readonly currentGeneration: number;
  readonly previousDigest: string;
  readonly targetDigest: string;
  readonly now?: () => Date;
  readonly randomId?: () => string;
}

export async function beginUpdate(options: BeginUpdateOptions): Promise<UpdateJournal> {
  const directory = await openRoot(options.root);
  try {
    const root = `/proc/self/fd/${directory.fd}`;
    const existing = await readPinned(root);
    if (existing !== null) {
      if (
        existing.idempotencyKey === options.idempotencyKey &&
        existing.targetDigest === options.targetDigest &&
        existing.deploymentId === options.deploymentId
      )
        return existing;
      throw new Error('another update operation already owns the journal');
    }
    if (!Number.isSafeInteger(options.currentGeneration) || options.currentGeneration < 0)
      throw new Error('current generation must be a non-negative safe integer');
    const time = (options.now ?? (() => new Date()))().toISOString();
    const body: UpdateJournalBody = {
      schemaVersion: 2,
      deploymentId: options.deploymentId,
      updateId: (options.randomId ?? randomUUID)(),
      idempotencyKey: options.idempotencyKey,
      generation: options.currentGeneration + 1,
      previousDigest: options.previousDigest,
      targetDigest: options.targetDigest,
      phase: 'requested',
      createdAt: time,
      updatedAt: time,
      candidate: null,
      previousContainerId: null,
      failure: null,
    };
    const journal = seal(body);
    if (parseUpdateJournal(journal) === null) throw new Error('update request is invalid');
    try {
      await createPinned(root, journal);
      return journal;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const winner = await readPinned(root);
      if (
        winner !== null &&
        winner.idempotencyKey === options.idempotencyKey &&
        winner.targetDigest === options.targetDigest &&
        winner.deploymentId === options.deploymentId
      )
        return winner;
      throw new Error('another update operation won the journal', { cause: error });
    }
  } finally {
    await directory.close();
  }
}

export async function advanceUpdate(
  rootPath: string,
  expected: PreparationPhase,
  next: PreparationPhase,
  options: {
    readonly now?: () => Date;
    readonly candidate?: { readonly containerId: string; readonly containerName: string };
  } = {},
): Promise<UpdateJournal> {
  const directory = await openRoot(rootPath);
  try {
    const root = `/proc/self/fd/${directory.fd}`;
    const current = await readPinned(root);
    if (current === null) throw new Error('update journal does not exist');
    if (current.phase !== expected)
      throw new Error(`update phase is ${current.phase}, not ${expected}`);
    if (expected === 'failed' || NEXT[expected] !== next)
      throw new Error(`invalid update phase transition: ${expected} -> ${next}`);
    const body: UpdateJournalBody = {
      ...bodyOf(current),
      phase: next,
      updatedAt: (options.now ?? (() => new Date()))().toISOString(),
      candidate: next === 'standby' ? (options.candidate ?? null) : null,
      previousContainerId: null,
      failure: null,
    };
    const journal = seal(body);
    if (parseUpdateJournal(journal) === null) throw new Error('update transition is invalid');
    await replacePinned(root, journal);
    return journal;
  } finally {
    await directory.close();
  }
}

/** Advance the post-cutover transaction. A promoted Server is not a completed
 * update until every managed companion runs the same immutable image. */
export async function advanceCompanionReconciliation(
  rootPath: string,
  expected: 'committed' | 'reconciling-companions',
  next: 'reconciling-companions' | 'completed',
  options: { readonly now?: () => Date } = {},
): Promise<UpdateJournal> {
  const valid =
    (expected === 'committed' && next === 'reconciling-companions') ||
    (expected === 'reconciling-companions' && next === 'completed');
  if (!valid) throw new Error(`invalid companion phase transition: ${expected} -> ${next}`);
  const directory = await openRoot(rootPath);
  try {
    const root = `/proc/self/fd/${directory.fd}`;
    const current = await readPinned(root);
    if (current === null) throw new Error('update journal does not exist');
    if (current.phase !== expected)
      throw new Error(`update phase is ${current.phase}, not ${expected}`);
    const journal = seal({
      ...bodyOf(current),
      phase: next,
      updatedAt: (options.now ?? (() => new Date()))().toISOString(),
    });
    if (parseUpdateJournal(journal) === null) throw new Error('companion transition is invalid');
    await replacePinned(root, journal);
    return journal;
  } finally {
    await directory.close();
  }
}

const CUTOVER_NEXT: Readonly<Record<CutoverPhase, readonly CutoverPhase[]>> = {
  standby: ['quiescing-old'],
  'quiescing-old': ['handing-off-key'],
  'handing-off-key': ['activating-candidate', 'rollback-quiescing-candidate'],
  'activating-candidate': ['checking-candidate', 'rollback-quiescing-candidate'],
  'checking-candidate': ['draining-gateway', 'rollback-quiescing-candidate'],
  'draining-gateway': ['switching-gateway', 'rollback-quiescing-candidate'],
  'switching-gateway': ['observing-candidate', 'rollback-quiescing-candidate'],
  'observing-candidate': ['committed', 'rollback-quiescing-candidate'],
  committed: [],
  'reconciling-companions': [],
  completed: [],
  'rollback-quiescing-candidate': ['rollback-activating-old'],
  'rollback-activating-old': ['rollback-switching-gateway'],
  'rollback-switching-gateway': ['rolled-back'],
  'rolled-back': [],
};

export async function advanceCutover(
  rootPath: string,
  expected: CutoverPhase,
  next: CutoverPhase,
  options: { readonly previousContainerId?: string; readonly now?: () => Date } = {},
): Promise<UpdateJournal> {
  const directory = await openRoot(rootPath);
  try {
    const root = `/proc/self/fd/${directory.fd}`;
    const current = await readPinned(root);
    if (current === null) throw new Error('update journal does not exist');
    if (current.phase !== expected)
      throw new Error(`update phase is ${current.phase}, not ${expected}`);
    if (!CUTOVER_NEXT[expected].includes(next))
      throw new Error(`invalid cutover phase transition: ${expected} -> ${next}`);
    const previousContainerId = current.previousContainerId ?? options.previousContainerId ?? null;
    if (expected === 'standby' && previousContainerId === null)
      throw new Error('cutover requires the previous container identity');
    const journal = seal({
      ...bodyOf(current),
      phase: next,
      updatedAt: (options.now ?? (() => new Date()))().toISOString(),
      previousContainerId,
      failure: null,
    });
    if (parseUpdateJournal(journal) === null) throw new Error('cutover transition is invalid');
    await replacePinned(root, journal);
    return journal;
  } finally {
    await directory.close();
  }
}

const TERMINAL_PHASES: readonly UpdatePhase[] = ['completed', 'rolled-back', 'failed'];

/**
 * Free the single-slot journal once its operation has finished, retaining the
 * record under a generation-derived name.
 *
 * Only a terminal operation may be archived — an in-flight one would lose the
 * intent that crash recovery depends on. The archive name is derived from the
 * monotone generation rather than from any journal-supplied text, so nothing in
 * the file can influence the path it is renamed to. Callers must hold the
 * journal lease.
 */
export async function archiveUpdateJournal(rootPath: string): Promise<UpdateJournal | null> {
  const directory = await openRoot(rootPath);
  try {
    const root = `/proc/self/fd/${directory.fd}`;
    const current = await readPinned(root);
    if (current === null) return null;
    if (!TERMINAL_PHASES.includes(current.phase))
      throw new Error(`update operation is still in progress: ${current.phase}`);
    await rename(
      join(root, UPDATE_JOURNAL_FILE),
      join(root, `update-journal-g${String(current.generation)}.json`),
    );
    await syncDirectory(root);
    return current;
  } finally {
    await directory.close();
  }
}

const ARCHIVED_JOURNAL = /^update-journal-g(\d+)\.json$/;

/**
 * Highest generation this deployment has ever reached, live or archived.
 *
 * The fence depends on generations never regressing, and archiving the
 * finished journal is necessarily a separate step from starting its successor:
 * a crash in between leaves no live journal at all. Reading the archives too
 * means the next operation still continues above everything that came before
 * instead of restarting at 1 and re-using a generation the old container may
 * still consider its own.
 */
export async function readHighestGeneration(rootPath: string): Promise<number> {
  const directory = await openRoot(rootPath);
  try {
    const root = `/proc/self/fd/${directory.fd}`;
    const live = await readPinned(root);
    let highest = live?.generation ?? 0;
    for (const entry of await readdir(root)) {
      const match = ARCHIVED_JOURNAL.exec(entry);
      if (match === null) continue;
      const generation = Number(match[1]);
      if (Number.isSafeInteger(generation) && generation > highest) highest = generation;
    }
    return highest;
  } finally {
    await directory.close();
  }
}

export async function failUpdate(
  rootPath: string,
  expected: Exclude<PreparationPhase, 'failed' | 'standby'>,
  code: string,
  now: () => Date = () => new Date(),
): Promise<UpdateJournal> {
  const directory = await openRoot(rootPath);
  try {
    const root = `/proc/self/fd/${directory.fd}`;
    const current = await readPinned(root);
    if (current === null || current.phase !== expected)
      throw new Error('update journal phase changed before failure was recorded');
    const journal = seal({
      ...bodyOf(current),
      phase: 'failed',
      updatedAt: now().toISOString(),
      candidate: null,
      failure: { code },
    });
    if (parseUpdateJournal(journal) === null) throw new Error('update failure record is invalid');
    await replacePinned(root, journal);
    return journal;
  } finally {
    await directory.close();
  }
}
