import { timingSafeEqual } from 'node:crypto';
import { createServer, request, type Server } from 'node:http';
import { chmod, chown, lstat, mkdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readManagedDeployment, type ManagedDeploymentState } from './managed-deployment.js';
import type { ManagedServerReconcileVerdict } from './managed-server-owner.js';
import {
  readAgentSeedStamp,
  AGENT_SEED_STAMP_VERSION,
  type AgentSeedStamp,
} from './agent-seed-stamp.js';
import { parseServerDeploymentSpec } from './deployment-spec.js';
import {
  archiveUpdateJournal,
  beginUpdate,
  readHighestGeneration,
  readUpdateJournal,
  withUpdateJournalLease,
  type UpdateJournal,
} from './update-journal.js';
import {
  isTerminalOperationState,
  parseUpdateOperation,
  projectUpdateOperation,
  type UpdateOperation,
} from './update-operation.js';
import { generationOperationId } from './docker-update-preparation.js';
import type { ControlPlanePostgresState } from './postgres-image.js';
import {
  createSecretKeyHandoffMailbox,
  type SecretKeyHandoffMailbox,
} from './secret-key-handoff-mailbox.js';
import {
  parseKeyHandoffBinding,
  parseKeyHandoffEnvelope,
  parseKeyHandoffOffer,
  parseKeyHandoffPublicKey,
  type KeyHandoffBinding,
  type KeyHandoffEnvelope,
  type KeyHandoffOffer,
} from './secret-key-handoff.js';
import {
  parseStandbyDirective,
  standbyDirectiveForPhase,
  type StandbyDirective,
  type StandbyDirectiveState,
  type StandbyExchange,
} from './standby-directive.js';

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 4 * 1024;
/**
 * Handoff messages are larger than an update request but still bounded: the
 * widest of them is an envelope whose ciphertext wraps a key of at most
 * `MAX_KEY_BYTES`. Given its own limit so relaying a key never forces the
 * update route to accept bodies it has no use for.
 */
const MAX_HANDOFF_REQUEST_BYTES = 16 * 1024;

/**
 * The control socket both sides agree on: the Updater binds it, and the managed
 * Server finds it here through the `verity-updater-control` volume the sealed
 * spec mounts at `/run/verity-updater/control`.
 */
export const UPDATER_CONTROL_SOCKET = '/run/verity-updater/control/updater.sock';

const OFFICIAL_DIGEST = /^ghcr\.io\/heey-global\/verity\/verity-server@sha256:[a-f0-9]{64}$/;
const IDEMPOTENCY_KEY = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;

/** Closed set of machine-readable outcomes the Server may relay to a device. */
export const UPDATER_ERROR_CODES = [
  'invalid-request',
  'unauthorized',
  'unmanaged',
  'already-current',
  'operation-in-progress',
  'unavailable',
] as const;

export type UpdaterErrorCode = (typeof UPDATER_ERROR_CODES)[number];

export class UpdaterRequestError extends Error {
  readonly status: number;
  readonly code: UpdaterErrorCode;
  constructor(status: number, code: UpdaterErrorCode) {
    super(`updater rejected the request: ${code}`);
    this.name = 'UpdaterRequestError';
    this.status = status;
    this.code = code;
  }
}

function authorized(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function removeOwnedSocket(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isSocket()) throw new Error('updater control path exists and is not a socket');
    if (info.uid !== process.geteuid?.())
      throw new Error('updater control socket is not owned by this process');
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Remove an entry this process published, refusing anything it did not.
 *
 * Same reasoning as {@link removeOwnedSocket}, applied to the token: the control
 * directory is verified to be updater-owned and canonical before any of this
 * runs, but the entries inside it are still removed by path. An unrestricted
 * `rm` would delete whatever that name resolves to — a directory, a mount, a
 * file belonging to someone else — so the type and owner are checked first and a
 * mismatch fails the startup rather than being cleaned away.
 */
async function removeOwnedFile(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error('updater control token path is not a regular file');
    if (info.uid !== process.geteuid?.())
      throw new Error('updater control token is not owned by this process');
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Where the bearer token is published for a peer that may use the socket.
 * Both sides derive it from the socket path so the two never drift apart.
 */
export function updaterControlTokenPath(socketPath: string): string {
  return join(dirname(socketPath), 'token');
}

/**
 * Publish the token for the peer group. Written to a private temporary file and
 * renamed into place, so a reader sees either the whole previous token or the
 * whole new one — never a truncated file mid-write. The mode is set explicitly
 * after the write because an inherited umask can only take permissions away and
 * `writeFile` will not widen an existing file.
 *
 * The temporary file holds the bearer token in clear, so it must not outlive a
 * failed publish: an abandoned copy would sit in a directory the peer group can
 * traverse, and the token stays valid for as long as the Updater keeps serving
 * with it. Anything that goes wrong after the write therefore removes it before
 * the failure propagates.
 */
export async function publishControlToken(path: string, token: string, gid: number): Promise<void> {
  const temporary = `${path}.tmp`;
  await removeOwnedFile(temporary);
  await writeFile(temporary, token, { mode: 0o640, flag: 'wx' });
  try {
    await chown(temporary, process.geteuid?.() ?? 0, gid);
    await chmod(temporary, 0o640);
    await rename(temporary, path);
  } catch (error) {
    await removeOwnedFile(temporary);
    throw error;
  }
}

export interface UpdaterStatusServerOptions {
  readonly socketPath: string;
  readonly token: string;
  readonly managedRoot: string;
  /** Private directory holding the update journal; defaults to `managedRoot`. */
  readonly journalRoot?: string;
  /**
   * Group ID allowed to use the control socket — the managed Server's primary
   * group. When set, the directory, the socket, and a published copy of the
   * bearer token become `root:<peerGid>` with group access, and the directory
   * stays group-non-writable so the peer can neither unlink nor replace either
   * file. Absent, the whole boundary stays owner-only and no token is published.
   */
  readonly peerGid?: number;
  /**
   * Invoked after a new operation has been journalled and the lease released.
   * The Updater process uses this to start the crash-resumable execution; the
   * control boundary itself never touches Docker.
   */
  readonly onOperationAccepted?: (journal: UpdateJournal) => void;
  /**
   * The Updater's memory of the standby exchange (ADR 0008 D9), shared with the
   * cutover executor: it writes the one request the journal cannot express, and
   * reads what the outgoing Server answered.
   *
   * Absent, `/v1/standby` still derives a directive from the journal — so a
   * Server reads it and quiesces on the phases that imply it — but nothing
   * records the answer and nothing can ask mid-`quiescing-old`, so the cutover
   * falls back to stopping the container.
   */
  readonly standby?: StandbyExchange;
  /**
   * Host directory holding the agent-seed toolkit, mounted read-only. The
   * Updater is the only managed-topology component that can see it: the Server's
   * mounts are fixed by the sealed deployment spec, which allows four of them,
   * none read-only, and the fourth is the control socket this server listens on.
   *
   * This process uses the mount read-only for reporting. Publication runs in an
   * operation-bound target-image helper with the parent mounted at its fixed
   * private target; the Updater never mutates this mount incrementally. Absent,
   * `/v1/agent-seed` answers that the seed is not visible from here.
   */
  readonly agentSeedPath?: string;
  /**
   * What the Updater's startup reconcile concluded about the Server it found,
   * answered by `GET /v1/reconcile`.
   *
   * `reconcileManagedServer` no longer refuses to run over an environment
   * mismatch on a RUNNING Server — it keeps the Server and records which sealed
   * names disagree. That tolerance is only defensible if the disagreement is
   * visible, which is what this reports. Absent, the route answers `unknown`,
   * which is what a boundary started without a recovery verdict should say.
   */
  readonly reconcile?: ManagedServerReconcileVerdict;
  /**
   * What the control-plane PostgreSQL is running, against the pin the installed
   * Server release names (ADR 0008 D14).
   *
   * Injected rather than derived here, because answering it needs the Docker
   * socket and this boundary deliberately holds none of the Updater's Docker
   * capability. Absent, `/v1/postgres` answers that nothing is known — the shape
   * a deployment whose Updater predates the label lands in anyway.
   */
  readonly postgres?: () => Promise<ControlPlanePostgresState>;
}

export interface UpdaterStatusServer {
  close(): Promise<void>;
}

/** Read-only Updater boundary plus the single mutating update action. It
 * deliberately exposes neither Docker verbs nor arbitrary paths. */
export async function startUpdaterStatusServer(
  options: UpdaterStatusServerOptions,
): Promise<UpdaterStatusServer> {
  if (options.token.length < 32)
    throw new Error('updater control token must contain at least 32 bytes');
  const peerGid = options.peerGid;
  if (peerGid !== undefined && (!Number.isSafeInteger(peerGid) || peerGid < 0))
    throw new Error('updater control peer group must be a group ID');
  const socketDirectory = dirname(options.socketPath);
  await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(socketDirectory);
  if (
    directoryInfo.isSymbolicLink() ||
    !directoryInfo.isDirectory() ||
    directoryInfo.uid !== process.geteuid?.() ||
    (await realpath(socketDirectory)) !== socketDirectory
  ) {
    throw new Error('updater control directory must be updater-owned and canonical');
  }
  if (peerGid === undefined) {
    await chmod(socketDirectory, 0o700);
  } else {
    await chown(socketDirectory, process.geteuid?.() ?? 0, peerGid);
    // Traversable and readable by the peer group, writable by nobody but the
    // Updater: the peer can open the socket and the token but cannot remove or
    // substitute either of them.
    await chmod(socketDirectory, 0o750);
  }
  await removeOwnedSocket(options.socketPath);
  const tokenPath = updaterControlTokenPath(options.socketPath);
  await removeOwnedFile(tokenPath);
  // RAM-only and owned by the listener: the handoff exists for as long as the
  // control boundary is up and never outlives it.
  const mailbox = createSecretKeyHandoffMailbox();
  const fence: JournalFence = { generation: 0, stage: 0 };
  const server = createServer((req, res) => {
    void serveUpdaterRequest(req, res, options, mailbox, fence);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  // Everything from here on runs with the listener already bound, so a failure
  // is not just a rejected promise: it would leave a socket that accepts
  // requests behind a caller who believes the boundary never opened, and the
  // stale socket would then fail the next start's ownership check. Anything that
  // goes wrong therefore takes the listener down with it.
  try {
    if (peerGid === undefined) {
      await chmod(options.socketPath, 0o600);
    } else {
      await chown(options.socketPath, process.geteuid?.() ?? 0, peerGid);
      await chmod(options.socketPath, 0o660);
      // Published last: a peer that can read the token can also reach the socket.
      await publishControlToken(tokenPath, options.token, peerGid);
    }
  } catch (error) {
    await closeServer(server);
    await removeOwnedSocket(options.socketPath);
    throw error;
  }
  return {
    async close() {
      mailbox.discard();
      // An acknowledgement describes a process that is running right now; it may
      // not outlive the boundary that collected it.
      options.standby?.discard();
      await closeServer(server);
      await removeOwnedSocket(options.socketPath);
      await removeOwnedFile(tokenPath);
    },
  };
}

function readBody(
  req: import('node:http').IncomingMessage,
  maxBytes = MAX_REQUEST_BYTES,
): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

interface UpdateRequestBody {
  readonly idempotencyKey: string;
  readonly targetDigest: string;
}

function parseUpdateRequest(raw: string | null): UpdateRequestBody | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    typeof record.idempotencyKey !== 'string' ||
    !IDEMPOTENCY_KEY.test(record.idempotencyKey) ||
    typeof record.targetDigest !== 'string' ||
    !OFFICIAL_DIGEST.test(record.targetDigest)
  )
    return null;
  return { idempotencyKey: record.idempotencyKey, targetDigest: record.targetDigest };
}

/**
 * Accept an update request against the sealed authority.
 *
 * A matching in-flight key is answered from the durable journal without taking
 * the lease, so a client retry during execution stays idempotent. Anything that
 * mutates the slot runs under the crash-released single-writer lease; failing to
 * acquire it means another Updater action owns the journal, which is reported as
 * a conflict rather than being forced.
 */
async function acceptUpdateRequest(
  options: UpdaterStatusServerOptions,
  body: UpdateRequestBody,
): Promise<{ operation: UpdateOperation; accepted: UpdateJournal | null }> {
  const journalRoot = options.journalRoot ?? options.managedRoot;
  // Without an executor there is nothing to carry the operation past
  // `requested`. Journaling it anyway would occupy the single slot with an
  // update that can never move or be superseded by a retry, so an Updater
  // running without one refuses the request instead of accepting it.
  if (options.onOperationAccepted === undefined) throw new UpdaterRequestError(503, 'unavailable');
  const state = await readManagedDeployment(options.managedRoot);
  if (!state.managed) throw new UpdaterRequestError(503, 'unmanaged');
  if (!OFFICIAL_DIGEST.test(state.spec.image)) throw new UpdaterRequestError(503, 'unmanaged');
  if (state.spec.image === body.targetDigest) throw new UpdaterRequestError(409, 'already-current');

  const existing = await readUpdateJournal(journalRoot);
  if (
    existing !== null &&
    existing.idempotencyKey === body.idempotencyKey &&
    existing.targetDigest === body.targetDigest &&
    existing.deploymentId === state.marker.deploymentId
  ) {
    const operation = projectUpdateOperation(existing);
    // Retrying the same request is idempotent — and it is also the only way to
    // restart an operation that stalled. A step that failed for a transient
    // reason (a daemon hiccup, a pull that timed out) leaves durable intent
    // behind that nothing is driving until the Updater itself restarts, so a
    // retry re-arms execution rather than only reporting. Safe to do
    // unconditionally: runs are serialized, every run re-reads the journal, and
    // a run that finds nothing to do returns without touching anything.
    return {
      operation,
      accepted: isTerminalOperationState(operation.state) ? null : existing,
    };
  }

  const begin = async (): Promise<UpdateJournal> => {
    const current = await readUpdateJournal(journalRoot);
    if (current !== null) {
      if (
        current.idempotencyKey === body.idempotencyKey &&
        current.targetDigest === body.targetDigest &&
        current.deploymentId === state.marker.deploymentId
      )
        return current;
      if (!isTerminalOperationState(projectUpdateOperation(current).state))
        throw new UpdaterRequestError(409, 'operation-in-progress');
    }
    // Generations must stay monotone across operations regardless of outcome.
    // Archiving and beginning cannot be one atomic step, so the successor is
    // numbered from the highest generation on record — live or archived —
    // rather than from the journal that happens to be present right now.
    if (current !== null) await archiveUpdateJournal(journalRoot);
    return beginUpdate({
      root: journalRoot,
      deploymentId: state.marker.deploymentId,
      idempotencyKey: body.idempotencyKey,
      currentGeneration: await readHighestGeneration(journalRoot),
      previousDigest: state.spec.image,
      targetDigest: body.targetDigest,
    });
  };

  let journal: UpdateJournal;
  try {
    journal = await withUpdateJournalLease(journalRoot, begin);
  } catch (error) {
    if (error instanceof UpdaterRequestError) throw error;
    if ((error as Error).message.includes('owns the update journal'))
      throw new UpdaterRequestError(409, 'operation-in-progress');
    throw error;
  }
  return { operation: projectUpdateOperation(journal), accepted: journal };
}

/**
 * The binding the two Servers are allowed to hand a key over for, or `null`
 * when no update is at a point where a handoff means anything.
 *
 * Derived entirely from the Updater's own journal, never from what a peer
 * claims: `operationId` is the generation the candidate was created for,
 * `targetDigest` the image it runs, and `containerId` the container the Updater
 * itself created. A candidate only exists between `creating-standby` and a
 * terminal state, which is exactly the window in which a handoff can still be
 * used — so a finished operation resolves to `null` and the relayed material is
 * dropped rather than left in memory for a peer that no longer exists.
 */
async function resolveHandoffBinding(
  options: UpdaterStatusServerOptions,
  mailbox: SecretKeyHandoffMailbox,
  fence: JournalFence,
): Promise<KeyHandoffBinding | null> {
  const root = options.journalRoot ?? options.managedRoot;
  const journal = await readUpdateJournal(root);
  // Reading the journal is the one slow step of a handoff request, and requests
  // are served concurrently, so two of them can resolve in the opposite order to
  // the states they read. Acting on the older of the two would let a finished
  // operation discard the mailbox of the one that replaced it, or a superseded
  // state re-select the mailbox a finished one had already cleared. Whichever
  // way round, the request is refused instead of served; both peers poll, so the
  // next one carries the current state.
  const generation = journal?.generation ?? (await readHighestGeneration(root));
  const stage = handoffStage(journal);
  if (generation < fence.generation || (generation === fence.generation && stage < fence.stage))
    throw new Error('journal read is behind one already served');
  fence.generation = generation;
  fence.stage = stage;
  const binding =
    stage === HANDOFF_STAGE.open && journal?.candidate != null
      ? parseKeyHandoffBinding({
          operationId: generationOperationId(journal.generation),
          targetDigest: journal.targetDigest,
          containerId: journal.candidate.containerId,
        })
      : null;
  if (binding === null) mailbox.discard();
  return binding;
}

/**
 * How far the operation of a given generation has got, as far as a handoff is
 * concerned. Monotone: a candidate is created once and never un-created, and a
 * terminal operation never resumes — so an ordering by generation and then by
 * stage is an ordering in time, which is what makes the fence below sound.
 */
const HANDOFF_STAGE = { pending: 0, open: 1, closed: 2 } as const;

function handoffStage(journal: UpdateJournal | null): number {
  if (journal === null) return HANDOFF_STAGE.closed;
  if (
    journal.phase === 'committed' ||
    journal.phase === 'reconciling-companions' ||
    journal.phase === 'completed'
  )
    return HANDOFF_STAGE.closed;
  if (isTerminalOperationState(projectUpdateOperation(journal).state)) return HANDOFF_STAGE.closed;
  return journal.candidate === null ? HANDOFF_STAGE.pending : HANDOFF_STAGE.open;
}

/** The furthest point in this deployment's history any handoff request has
 * resolved so far. */
interface JournalFence {
  generation: number;
  stage: number;
}

/** One of the three things a peer may leave in the mailbox, or null. */
type HandoffMessage =
  | { readonly kind: 'sender-identity'; readonly value: unknown }
  | { readonly kind: 'offer'; readonly value: unknown }
  | { readonly kind: 'envelope'; readonly value: unknown };

function parseHandoffMessage(raw: string | null): HandoffMessage | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1) return null;
  if (Object.hasOwn(record, 'senderIdentityPublicKey'))
    return { kind: 'sender-identity', value: record.senderIdentityPublicKey };
  if (Object.hasOwn(record, 'offer')) return { kind: 'offer', value: record.offer };
  if (Object.hasOwn(record, 'envelope')) return { kind: 'envelope', value: record.envelope };
  return null;
}

/**
 * The secret-key handoff relay (ADR 0008 D8).
 *
 * Three routes, none of which the Updater can interpret: it publishes the
 * binding it derived, accepts messages that match it, and hands the sealed
 * envelope to whoever asks for it. Nothing here can fail an update — a
 * refusal only means the promoted Server starts sealed and asks for the master
 * password, which is what it did before any of this existed.
 */
async function serveHandoffRequest(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  options: UpdaterStatusServerOptions,
  mailbox: SecretKeyHandoffMailbox,
  fence: JournalFence,
  path: string,
): Promise<void> {
  // The body first, because reading it is the one slow step here and the binding
  // must not go stale across it: a publication that selected the mailbox for an
  // operation the journal has since left behind would clear the state of the one
  // that replaced it. Resolved below and used without an await in between, so
  // what a message is checked against is what the journal says at that instant.
  const body =
    path === '/v1/handoff' && req.method === 'POST'
      ? await readBody(req, MAX_HANDOFF_REQUEST_BYTES)
      : null;
  let binding: KeyHandoffBinding | null;
  try {
    binding = await resolveHandoffBinding(options, mailbox, fence);
  } catch {
    res.writeHead(503).end(JSON.stringify({ error: 'unavailable' }));
    return;
  }
  if (path === '/v1/handoff/envelope') {
    const envelope = binding === null ? undefined : mailbox.readEnvelope(binding);
    res.writeHead(200).end(JSON.stringify({ envelope: envelope ?? null }));
    return;
  }
  if (req.method === 'GET') {
    const handoff = binding === null ? null : { binding: { ...binding }, ...mailbox.read(binding) };
    res.writeHead(200).end(JSON.stringify({ handoff }));
    return;
  }
  const message = parseHandoffMessage(body);
  if (message === null) {
    res.writeHead(400).end(JSON.stringify({ error: 'invalid-request' }));
    return;
  }
  const published =
    binding !== null &&
    (message.kind === 'sender-identity'
      ? mailbox.publishSenderIdentity(binding, message.value)
      : message.kind === 'offer'
        ? mailbox.publishOffer(binding, message.value)
        : mailbox.publishEnvelope(binding, message.value));
  res.writeHead(published ? 202 : 409).end(JSON.stringify({ published }));
}

/**
 * The standby directive (ADR 0008 D9), derived from the journal on every read.
 *
 * Almost nothing is stored: the phase already says whether the old generation is
 * supposed to be the control plane, so an Updater that crashed mid-cutover and
 * resumed republishes the same directive without reconciling anything. A
 * deployment with no journal at all has no cutover under way and therefore no
 * directive — which the Server reads as "serve", the state it is already in.
 *
 * The exception is the drain (see `standbyDirectiveForPhase`), and losing that
 * request to a restart is safe in the only direction that matters: the phase
 * alone reads as `serving`, so a standby resumes and the resumed cutover drains
 * and asks again.
 */
async function resolveStandbyDirective(
  options: UpdaterStatusServerOptions,
): Promise<StandbyDirectiveState | null> {
  const journal = await readUpdateJournal(options.journalRoot ?? options.managedRoot);
  if (journal === null) return null;
  const operationId = generationOperationId(journal.generation);
  return {
    directive: standbyDirectiveForPhase(
      journal.phase,
      options.standby?.requested(operationId) === 'quiesced',
    ),
    operationId,
    acknowledged: options.standby?.acknowledged(operationId) ?? null,
  };
}

interface StandbyAcknowledgement {
  readonly operationId: string;
  readonly state: StandbyDirective;
}

function parseStandbyAcknowledgement(raw: string | null): StandbyAcknowledgement | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return null;
  const record = value as Record<string, unknown>;
  const state = parseStandbyDirective(record.state);
  const operationId = record.operationId;
  if (state === null || typeof operationId !== 'string' || !IDEMPOTENCY_KEY.test(operationId))
    return null;
  return { operationId, state };
}

/**
 * Read the directive, or acknowledge having reached it.
 *
 * An acknowledgement is only recorded when it names the operation the journal
 * is actually on. That is the whole authentication the record needs: the socket
 * is already reachable only by the managed Server's group, and a Server
 * answering for a superseded operation is describing a state the cutover has no
 * use for. Refusing it (409) rather than storing it keeps the cutover's wait
 * honest — it waits for the standby of *this* update or falls back.
 */
async function serveStandbyRequest(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  options: UpdaterStatusServerOptions,
): Promise<void> {
  // Read the body first so the journal is consulted at the instant the answer is
  // decided, not before a slow read of the request.
  const body = req.method === 'POST' ? await readBody(req) : null;
  let standby: StandbyDirectiveState | null;
  try {
    standby = await resolveStandbyDirective(options);
  } catch {
    res.writeHead(503).end(JSON.stringify({ error: 'unavailable' }));
    return;
  }
  if (req.method === 'GET') {
    res.writeHead(200).end(JSON.stringify({ standby }));
    return;
  }
  const acknowledgement = parseStandbyAcknowledgement(body);
  if (acknowledgement === null) {
    res.writeHead(400).end(JSON.stringify({ error: 'invalid-request' }));
    return;
  }
  const recorded =
    standby !== null &&
    standby.operationId === acknowledgement.operationId &&
    options.standby !== undefined;
  if (recorded) options.standby?.acknowledge(acknowledgement.operationId, acknowledgement.state);
  res.writeHead(recorded ? 202 : 409).end(JSON.stringify({ recorded }));
}

/**
 * Every request the Updater control socket answers, as `METHOD path`. The
 * listener is closed over this list: anything absent is 404 before the bearer
 * token is read. It is exported so a test can assert the entire boundary rather
 * than guess at the names of routes that should not exist — see
 * `project-network-refusal.test.ts`, which holds it to no network verb.
 */
export const UPDATER_CONTROL_ROUTES = [
  'GET /v1/deployment',
  'GET /v1/reconcile',
  'GET /v1/update',
  'POST /v1/update',
  'GET /v1/handoff',
  'POST /v1/handoff',
  'POST /v1/handoff/envelope',
  'GET /v1/standby',
  'POST /v1/standby',
  'GET /v1/agent-seed',
  'GET /v1/postgres',
] as const;

const updaterControlRoutes: ReadonlySet<string> = new Set(UPDATER_CONTROL_ROUTES);

async function serveUpdaterRequest(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  options: UpdaterStatusServerOptions,
  mailbox: SecretKeyHandoffMailbox,
  fence: JournalFence,
): Promise<void> {
  res.setHeader('content-type', 'application/json');
  const path = req.url ?? '';
  const known = updaterControlRoutes.has(`${req.method ?? ''} ${path}`);
  if (!known) {
    res.writeHead(404).end(JSON.stringify({ error: 'not found' }));
    return;
  }
  if (!authorized(req.headers.authorization, options.token)) {
    res.writeHead(401).end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  if (path.startsWith('/v1/handoff')) {
    await serveHandoffRequest(req, res, options, mailbox, fence, path);
    return;
  }
  if (path === '/v1/standby') {
    await serveStandbyRequest(req, res, options);
    return;
  }
  if (path === '/v1/deployment') {
    try {
      const state = await readManagedDeployment(options.managedRoot);
      res.writeHead(200).end(JSON.stringify(state));
    } catch {
      res.writeHead(503).end(JSON.stringify({ error: 'managed authority unavailable' }));
    }
    return;
  }
  if (path === '/v1/reconcile') {
    // A separate route, and NOT a field on `/v1/deployment`, for the same reason
    // `/v1/agent-seed` is separate: that payload is parsed with exact key counts
    // on the Server side, and a cutover deliberately runs two Server generations
    // at once — widening it would make the outgoing generation reject the
    // authority it is handing over to.
    //
    // Values are never included. A drift report names `DATABASE_URL`; it does not
    // say what either side thinks `DATABASE_URL` is.
    res.writeHead(200).end(JSON.stringify(options.reconcile ?? { status: 'unknown' }));
    return;
  }
  if (path === '/v1/postgres') {
    // A separate route for the same reason `/v1/agent-seed` is one: `/v1/deployment`
    // is parsed with exact key counts on the Server side, and a cutover runs two
    // Server generations at once, so widening it would make the outgoing
    // generation reject the authority it is handing over to.
    const unknown: ControlPlanePostgresState = {
      running: null,
      bundled: null,
      upToDate: null,
      blocked: null,
    };
    const state = await (options.postgres?.() ?? Promise.resolve(unknown)).catch(() => unknown);
    res.writeHead(200).end(JSON.stringify(state));
    return;
  }
  if (path === '/v1/agent-seed') {
    // A separate route rather than a field on `/v1/deployment`, because that
    // payload is parsed with exact key counts on the Server side and a cutover
    // deliberately runs two Server generations at once. Widening it would make
    // the outgoing generation reject the authority it is handing over to.
    const seedPath = options.agentSeedPath;
    const stamp = seedPath === undefined ? null : await readAgentSeedStamp(seedPath);
    res.writeHead(200).end(
      JSON.stringify({
        // `visible` separates "no seed mounted here" from "seed mounted, no
        // stamp in it" — the first is a deployment that predates this mount,
        // the second is a seed that predates stamping. Only the second says
        // anything about the seed the sandboxes are actually running.
        visible: seedPath !== undefined,
        stamp,
      }),
    );
    return;
  }
  if (req.method === 'GET') {
    try {
      const journal = await readUpdateJournal(options.journalRoot ?? options.managedRoot);
      const operation = journal === null ? null : projectUpdateOperation(journal);
      res.writeHead(200).end(JSON.stringify({ operation }));
    } catch {
      res.writeHead(503).end(JSON.stringify({ error: 'unavailable' }));
    }
    return;
  }
  const body = parseUpdateRequest(await readBody(req));
  if (body === null) {
    res.writeHead(400).end(JSON.stringify({ error: 'invalid-request' }));
    return;
  }
  try {
    const { operation, accepted } = await acceptUpdateRequest(options, body);
    res.writeHead(202).end(JSON.stringify({ operation }));
    // Execution starts only after the lease is released and the caller has its
    // answer; a failure to start is recorded in the journal by the runner.
    if (accepted !== null) options.onOperationAccepted?.(accepted);
  } catch (error) {
    if (error instanceof UpdaterRequestError) {
      res.writeHead(error.status).end(JSON.stringify({ error: error.code }));
      return;
    }
    res.writeHead(503).end(JSON.stringify({ error: 'unavailable' }));
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

/**
 * How long one call to the Updater may take before it is given up on.
 *
 * Exported because a caller that waits on a sequence of these has to budget for
 * them; guessing shorter would abandon a request that was still within its
 * allowance.
 */
export const UPDATER_REQUEST_TIMEOUT_MS = 2_000;

interface UpdaterCallOptions {
  readonly socketPath: string;
  readonly token: string;
  readonly timeoutMs?: number;
}

function call(
  options: UpdaterCallOptions,
  route: { readonly method: 'GET' | 'POST'; readonly path: string; readonly body?: unknown },
): Promise<{ readonly status: number; readonly value: unknown }> {
  const payload = route.body === undefined ? undefined : Buffer.from(JSON.stringify(route.body));
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: options.socketPath,
        path: route.path,
        method: route.method,
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(payload === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': payload.length }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) req.destroy(new Error('updater response exceeds limit'));
          else chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              value: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            });
          } catch (error) {
            reject(new Error('updater returned invalid JSON', { cause: error }));
          }
        });
      },
    );
    req.setTimeout(options.timeoutMs ?? UPDATER_REQUEST_TIMEOUT_MS, () =>
      req.destroy(new Error('updater timed out')),
    );
    req.once('error', reject);
    req.end(payload);
  });
}

function errorCode(value: unknown): UpdaterErrorCode {
  const code =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>).error : null;
  return (UPDATER_ERROR_CODES as readonly unknown[]).includes(code)
    ? (code as UpdaterErrorCode)
    : 'unavailable';
}

export async function readUpdaterDeployment(
  options: UpdaterCallOptions,
): Promise<ManagedDeploymentState> {
  const { status, value } = await call(options, { method: 'GET', path: '/v1/deployment' });
  if (status !== 200) throw new Error(`updater status returned HTTP ${String(status)}`);
  const parsed = parseStatus(value);
  if (parsed === null) throw new Error('updater status returned invalid JSON');
  return parsed;
}

export interface UpdaterAgentSeed {
  /** Whether the Updater has the seed directory mounted at all. */
  readonly visible: boolean;
  /** What the seed says it was published from, or null when it says nothing. */
  readonly stamp: AgentSeedStamp | null;
}

/**
 * What the host's agent seed reports about its own origin.
 *
 * Never throws on an unhelpful answer: a Server that cannot learn the seed's
 * provenance must still start, provision, and serve. An Updater too old to know
 * the route answers 404 and lands in the same `not visible` shape as one without
 * the mount, which is the honest reading — neither can tell us.
 */
export async function readUpdaterAgentSeed(options: UpdaterCallOptions): Promise<UpdaterAgentSeed> {
  const { status, value } = await call(options, { method: 'GET', path: '/v1/agent-seed' });
  if (status !== 200) return { visible: false, stamp: null };
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return { visible: false, stamp: null };
  const record = value as Record<string, unknown>;
  if (record.visible !== true) return { visible: false, stamp: null };
  const stamp = record.stamp;
  if (typeof stamp !== 'object' || stamp === null || Array.isArray(stamp))
    return { visible: true, stamp: null };
  const fields = stamp as Record<string, unknown>;
  if (
    fields.schemaVersion !== AGENT_SEED_STAMP_VERSION ||
    typeof fields.image !== 'string' ||
    typeof fields.version !== 'string' ||
    (fields.publishedAt !== null && typeof fields.publishedAt !== 'string')
  )
    return { visible: true, stamp: null };
  return {
    visible: true,
    stamp: {
      schemaVersion: AGENT_SEED_STAMP_VERSION,
      image: fields.image,
      version: fields.version,
      publishedAt: fields.publishedAt,
    },
  };
}

const UNKNOWN_POSTGRES: ControlPlanePostgresState = {
  running: null,
  bundled: null,
  upToDate: null,
  blocked: null,
};

/**
 * What the Updater knows about the control-plane PostgreSQL image (ADR 0008 D14).
 *
 * Never throws, and that has to include the transport: this is reporting, a
 * Server that cannot learn one advisory fact still has to serve, and a socket
 * that is not there, a request that times out, and a body that is not JSON are
 * all the same answer — the Updater cannot tell us. An Updater too old to know
 * the route answers 404 and lands in the same all-null shape, which is honest
 * and is different from telling us the digests match.
 */
export async function readUpdaterPostgres(
  options: UpdaterCallOptions,
): Promise<ControlPlanePostgresState> {
  const { status, value } = await call(options, {
    method: 'GET',
    path: '/v1/postgres',
  }).catch(() => ({ status: 0, value: undefined }));
  if (status !== 200) return UNKNOWN_POSTGRES;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return UNKNOWN_POSTGRES;
  const record = value as Record<string, unknown>;
  const text = (field: unknown): string | null => (typeof field === 'string' ? field : null);
  return {
    running: text(record.running),
    bundled: text(record.bundled),
    upToDate: typeof record.upToDate === 'boolean' ? record.upToDate : null,
    blocked: record.blocked === 'major-version-change' ? 'major-version-change' : null,
  };
}

function parseOperationEnvelope(value: unknown): UpdateOperation | null | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, 'operation')) return undefined;
  if (record.operation === null) return null;
  return parseUpdateOperation(record.operation) ?? undefined;
}

/** Current operation as the Updater sees it, or `null` when none is recorded. */
export async function readUpdaterOperation(
  options: UpdaterCallOptions,
): Promise<UpdateOperation | null> {
  const { status, value } = await call(options, { method: 'GET', path: '/v1/update' });
  if (status !== 200) throw new UpdaterRequestError(status, errorCode(value));
  const operation = parseOperationEnvelope(value);
  if (operation === undefined) throw new Error('updater operation response is invalid');
  return operation;
}

export async function requestUpdaterOperation(
  options: UpdaterCallOptions & { readonly idempotencyKey: string; readonly targetDigest: string },
): Promise<UpdateOperation> {
  const { status, value } = await call(options, {
    method: 'POST',
    path: '/v1/update',
    body: { idempotencyKey: options.idempotencyKey, targetDigest: options.targetDigest },
  });
  if (status !== 202) throw new UpdaterRequestError(status, errorCode(value));
  const operation = parseOperationEnvelope(value);
  if (operation === undefined || operation === null)
    throw new Error('updater operation response is invalid');
  return operation;
}

/** The handoff as the Updater currently sees it. */
export interface UpdaterHandoffState {
  /** What both peers must bind their material to; the Updater's own view. */
  readonly binding: KeyHandoffBinding;
  readonly senderIdentityPublicKey?: string;
  readonly offer?: KeyHandoffOffer;
}

/** One message a peer leaves for the other. */
export type UpdaterHandoffMessage =
  | { readonly senderIdentityPublicKey: string }
  | { readonly offer: KeyHandoffOffer }
  | { readonly envelope: KeyHandoffEnvelope };

function parseHandoffEnvelopeState(value: unknown): UpdaterHandoffState | null | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, 'handoff')) return undefined;
  if (record.handoff === null) return null;
  const handoff = record.handoff;
  if (typeof handoff !== 'object' || handoff === null || Array.isArray(handoff)) return undefined;
  const fields = handoff as Record<string, unknown>;
  const binding = parseKeyHandoffBinding(fields.binding);
  if (binding === null) return undefined;
  const known = ['binding', 'senderIdentityPublicKey', 'offer'];
  if (Object.keys(fields).some((key) => !known.includes(key))) return undefined;
  const state: { -readonly [K in keyof UpdaterHandoffState]: UpdaterHandoffState[K] } = { binding };
  if (fields.senderIdentityPublicKey !== undefined) {
    const senderIdentityPublicKey = parseKeyHandoffPublicKey(fields.senderIdentityPublicKey);
    if (senderIdentityPublicKey === null) return undefined;
    state.senderIdentityPublicKey = senderIdentityPublicKey;
  }
  if (fields.offer !== undefined) {
    const offer = parseKeyHandoffOffer(fields.offer);
    if (offer === null) return undefined;
    state.offer = offer;
  }
  return state;
}

/**
 * What the Updater is relaying right now, or `null` when nothing is in flight.
 *
 * The response is re-parsed rather than trusted: the Updater is a relay, so most
 * of what it returns is whatever the *other* Server posted.
 */
export async function readUpdaterHandoff(
  options: UpdaterCallOptions,
): Promise<UpdaterHandoffState | null> {
  const { status, value } = await call(options, { method: 'GET', path: '/v1/handoff' });
  if (status !== 200) throw new UpdaterRequestError(status, errorCode(value));
  const handoff = parseHandoffEnvelopeState(value);
  if (handoff === undefined) throw new Error('updater handoff response is invalid');
  return handoff;
}

/**
 * Leave one message for the other Server. `false` means the Updater declined —
 * the binding moved on, or the message did not answer what it is relaying.
 */
export async function publishUpdaterHandoff(
  options: UpdaterCallOptions,
  message: UpdaterHandoffMessage,
): Promise<boolean> {
  const { status } = await call(options, {
    method: 'POST',
    path: '/v1/handoff',
    body: message,
  });
  if (status === 202) return true;
  if (status === 409) return false;
  throw new UpdaterRequestError(status, 'invalid-request');
}

/** Claim the sealed key, which the Updater delivers exactly once. */
export async function claimUpdaterHandoffEnvelope(
  options: UpdaterCallOptions,
): Promise<KeyHandoffEnvelope | null> {
  const { status, value } = await call(options, {
    method: 'POST',
    path: '/v1/handoff/envelope',
  });
  if (status !== 200) throw new UpdaterRequestError(status, errorCode(value));
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('updater handoff response is invalid');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, 'envelope'))
    throw new Error('updater handoff response is invalid');
  if (record.envelope === null) return null;
  const envelope = parseKeyHandoffEnvelope(record.envelope);
  if (envelope === null) throw new Error('updater handoff response is invalid');
  return envelope;
}

function parseStandbyEnvelope(value: unknown): StandbyDirectiveState | null | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, 'standby')) return undefined;
  if (record.standby === null) return null;
  const standby = record.standby;
  if (typeof standby !== 'object' || standby === null || Array.isArray(standby)) return undefined;
  const fields = standby as Record<string, unknown>;
  const directive = parseStandbyDirective(fields.directive);
  // An unreadable acknowledgement is not the same as no acknowledgement, and
  // `parseStandbyDirective` cannot tell them apart — only an explicit `null`
  // means the Server has not answered yet.
  const acknowledged =
    fields.acknowledged === null ? null : parseStandbyDirective(fields.acknowledged);
  if (
    directive === null ||
    (acknowledged === null && fields.acknowledged !== null) ||
    typeof fields.operationId !== 'string' ||
    Object.keys(fields).length !== 3
  )
    return undefined;
  return { directive, operationId: fields.operationId, acknowledged };
}

/**
 * What the Updater needs the outgoing Server to be, or `null` when no operation
 * is under way. Read by the Server's standby follower and by the cutover's own
 * wait for an acknowledgement.
 */
export async function readUpdaterStandby(
  options: UpdaterCallOptions,
): Promise<StandbyDirectiveState | null> {
  const { status, value } = await call(options, { method: 'GET', path: '/v1/standby' });
  if (status !== 200) throw new UpdaterRequestError(status, errorCode(value));
  const standby = parseStandbyEnvelope(value);
  if (standby === undefined) throw new Error('updater standby response is invalid');
  return standby;
}

/**
 * Report the state this Server actually reached. `false` means the Updater
 * declined it — the operation moved on, so the answer describes nothing it is
 * still waiting for.
 */
export async function acknowledgeUpdaterStandby(
  options: UpdaterCallOptions & {
    readonly operationId: string;
    readonly state: StandbyDirective;
  },
): Promise<boolean> {
  const { status } = await call(options, {
    method: 'POST',
    path: '/v1/standby',
    body: { operationId: options.operationId, state: options.state },
  });
  if (status === 202) return true;
  if (status === 409) return false;
  throw new UpdaterRequestError(status, 'invalid-request');
}

function parseStatus(value: unknown): ManagedDeploymentState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.managed === false) {
    return Object.keys(record).length === 2 && typeof record.reason === 'string'
      ? { managed: false, reason: record.reason }
      : null;
  }
  if (record.managed !== true || Object.keys(record).length !== 3) return null;
  const marker = record.marker;
  if (typeof marker !== 'object' || marker === null || Array.isArray(marker)) return null;
  const markerRecord = marker as Record<string, unknown>;
  if (
    Object.keys(markerRecord).length !== 2 ||
    markerRecord.schemaVersion !== 1 ||
    typeof markerRecord.deploymentId !== 'string'
  )
    return null;
  const spec = parseServerDeploymentSpec(record.spec);
  if (spec === null || spec.deploymentId !== markerRecord.deploymentId) return null;
  return {
    managed: true,
    marker: { schemaVersion: 1, deploymentId: markerRecord.deploymentId },
    spec,
  };
}
