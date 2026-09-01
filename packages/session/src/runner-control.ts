import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, rm, symlink, type FileHandle } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { PermissionDecision, PermissionRequest } from '@verity/adapter-claude';
import { RUNNER_FRAME_PROTOCOL_VERSION } from '@verity/store';
import type { SteerMessage } from './backend-contract.js';

/**
 * The Server -> Runner control transport (ADR 0006 D1/D5). Every command carries
 * a stable id and a controller lease epoch and receives a correlated reply. A
 * caller can therefore retry an ambiguously delivered command with the same id;
 * the live Runner applies it at most once and returns the journaled reply.
 *
 * The lease fence lives for the lifetime of this control server. Production Runner
 * turns additionally provide a durable command journal, so a process crash after an
 * external effect but before its outcome is synced recovers as `ambiguous` rather
 * than automatically replaying the command.
 */

const LF = 0x0a;
const MAX_CONTROL_LINE_BYTES = 1024 * 1024;

export interface ControlEnvelope {
  turnId: string;
  commandId: string;
  leaseEpoch: number;
}

interface ControlAttachRequest {
  kind: 'attach';
  turnId: string;
  controllerId: string;
  mode: 'inspect' | 'acquire' | 'resume';
  protocolVersion?: number;
  leaseEpoch?: number;
  capability?: string;
}

/**
 * The ADR 0006 D6 attach-handshake snapshot returned in the `attached` reply: what a
 * (re)attaching Server needs to decide reattach-vs-settle and reconstruct actionable
 * prompts without replaying the whole stream. `lastFrameSeq` is the highest durable
 * frame the Runner has produced (0 if none yet), so a recovering controller knows how
 * far the log has advanced; `turnStatus` is the live disposition; `outstandingPermissions`
 * are the still-open prompts (D8) so the new controller can re-surface them even when
 * the original request frame was already deduplicated; `protocolVersion` /
 * `runnerInstanceId` bind compatibility and instance identity (D3/D9).
 */
export interface ControlAttachSnapshot {
  protocolVersion: number;
  runnerInstanceId?: string;
  lastFrameSeq: number;
  turnStatus: 'running' | 'settled';
  outstandingPermissions: PermissionRequest[];
}

type ControlAttachReply =
  | ({
      kind: 'inspected';
      turnId: string;
    } & ControlAttachSnapshot)
  | ({
      kind: 'attached';
      turnId: string;
      controllerId: string;
      leaseEpoch: number;
    } & ControlAttachSnapshot)
  | {
      kind: 'attach-reject';
      turnId: string;
      reason: 'wrong-turn' | 'stale-controller' | 'incompatible-protocol';
    };

/** The D6 snapshot a live Runner reports when no richer state is available (no
 * frames yet, running, nothing parked) — the back-compatible default for a
 * {@link serveControl} caller that does not supply an `attachSnapshot` provider. */
function defaultAttachSnapshot(): ControlAttachSnapshot {
  return {
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    lastFrameSeq: 0,
    turnStatus: 'running',
    outstandingPermissions: [],
  };
}

export type ControlRequest =
  | ({ kind: 'steer'; message: SteerMessage } & ControlEnvelope)
  | ({ kind: 'cancel' } & ControlEnvelope)
  | ({
      kind: 'answer-permission';
      toolUseId: string;
      decision: PermissionDecision;
    } & ControlEnvelope);

export type ControlRejectReason =
  'stale-lease' | 'wrong-turn' | 'command-conflict' | 'ambiguous' | 'handler-error';

export type ControlReply =
  | { kind: 'ack'; commandId: string; injected?: boolean; applied?: boolean }
  | { kind: 'reject'; commandId: string; reason: ControlRejectReason };

export interface ControlAck {
  commandId: string;
  applied: boolean;
  reason?: ControlRejectReason | 'unreachable';
}

/**
 * The socket disappeared before a steer ACK arrived. This is intentionally not
 * represented as `false`: the command may already have been injected, so queueing
 * it as a fresh turn would risk duplicate execution. Reconnect with a newer lease
 * and retry the attached `commandId` to resolve the ambiguity from the journal.
 */
export class ControlDeliveryUnknownError extends Error {
  constructor(readonly commandId: string) {
    super(`control command '${commandId}' may have been delivered; retry it with the same id`);
    this.name = 'ControlDeliveryUnknownError';
  }
}

export class ControlCommandRejectedError extends Error {
  constructor(
    readonly commandId: string,
    readonly reason: Exclude<ControlRejectReason, 'handler-error'>,
  ) {
    super(`control command '${commandId}' was rejected: ${reason}`);
    this.name = 'ControlCommandRejectedError';
  }
}

export interface ControlCommandOptions {
  /** Reuse this id when retrying a command whose prior ACK was lost. */
  commandId?: string;
}

export interface ControlHandlers {
  steer(message: SteerMessage): boolean | Promise<boolean>;
  cancel(): boolean | Promise<boolean>;
  answerPermission(toolUseId: string, decision: PermissionDecision): boolean | Promise<boolean>;
}

export interface ControlSocketServer {
  readonly socketPath: string;
  close(): Promise<void>;
  readonly closed: Promise<void>;
}

function makeLineReader(
  onLine: (line: string) => void,
  onOverflow: () => void = () => undefined,
): (chunk: Buffer) => void {
  let pending = Buffer.alloc(0);
  return (chunk: Buffer): void => {
    let data = Buffer.concat([pending, chunk]);
    let nl = data.indexOf(LF);
    while (nl !== -1) {
      const lineBytes = data.subarray(0, nl);
      data = data.subarray(nl + 1);
      if (lineBytes.length > MAX_CONTROL_LINE_BYTES) {
        pending = Buffer.alloc(0);
        onOverflow();
        return;
      }
      const line = lineBytes.toString('utf8');
      if (line.trim() !== '') onLine(line);
      nl = data.indexOf(LF);
    }
    pending = data;
    if (pending.length > MAX_CONTROL_LINE_BYTES) {
      pending = Buffer.alloc(0);
      onOverflow();
    }
  };
}

function encodeLine(
  msg: ControlRequest | ControlReply | ControlAttachRequest | ControlAttachReply,
): string {
  return `${JSON.stringify(msg)}\n`;
}

function isEnvelope(value: unknown): value is ControlEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.commandId === 'string' &&
    record.commandId.length > 0 &&
    typeof record.turnId === 'string' &&
    record.turnId.length > 0 &&
    Number.isSafeInteger(record.leaseEpoch) &&
    Number(record.leaseEpoch) >= 1
  );
}

function isAttachRequest(value: unknown): value is ControlAttachRequest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === 'attach' &&
    typeof record.turnId === 'string' &&
    record.turnId.length > 0 &&
    typeof record.controllerId === 'string' &&
    record.controllerId.length > 0 &&
    ((record.mode === 'inspect' &&
      Number.isSafeInteger(record.protocolVersion) &&
      Number(record.protocolVersion) >= 1) ||
      (record.mode === 'acquire' &&
        Number.isSafeInteger(record.protocolVersion) &&
        Number(record.protocolVersion) >= 1) ||
      (record.mode === 'resume' &&
        Number.isSafeInteger(record.protocolVersion) &&
        Number(record.protocolVersion) >= 1 &&
        Number.isSafeInteger(record.leaseEpoch) &&
        Number(record.leaseEpoch) >= 1)) &&
    (record.protocolVersion === undefined ||
      (Number.isSafeInteger(record.protocolVersion) && Number(record.protocolVersion) >= 1))
  );
}

function isControlRequest(value: unknown): value is ControlRequest {
  if (!isEnvelope(value)) return false;
  const record = value as unknown as Record<string, unknown>;
  switch (record.kind) {
    case 'steer':
      return (
        typeof record.message === 'object' &&
        record.message !== null &&
        typeof (record.message as Record<string, unknown>).text === 'string'
      );
    case 'cancel':
      return true;
    case 'answer-permission':
      return (
        typeof record.toolUseId === 'string' &&
        record.toolUseId.length > 0 &&
        isPermissionDecision(record.decision)
      );
    default:
      return false;
  }
}

function isPermissionDecision(value: unknown): value is PermissionDecision {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.behavior === 'allow' &&
      (record.updatedInput === undefined ||
        (typeof record.updatedInput === 'object' && record.updatedInput !== null))) ||
    (record.behavior === 'deny' && typeof record.message === 'string')
  );
}

function isPermissionRequest(value: unknown): value is PermissionRequest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.requestId === 'string' &&
    record.requestId.length > 0 &&
    typeof record.toolName === 'string' &&
    record.toolName.length > 0 &&
    typeof record.input === 'object' &&
    record.input !== null &&
    !Array.isArray(record.input) &&
    typeof record.toolUseId === 'string' &&
    record.toolUseId.length > 0
  );
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  );
}

/** Stable comparison key used to detect accidental command-id reuse. */
function commandKey(request: ControlRequest): string {
  switch (request.kind) {
    case 'steer':
      return JSON.stringify(canonicalize({ kind: request.kind, message: request.message }));
    case 'cancel':
      return JSON.stringify({ kind: request.kind });
    case 'answer-permission':
      return JSON.stringify(
        canonicalize({
          kind: request.kind,
          toolUseId: request.toolUseId,
          decision: request.decision,
        }),
      );
  }
}

interface JournalEntry {
  readonly commandKey: string;
  readonly reply: Promise<ControlReply>;
}

type DurableJournalRecord =
  | {
      protocolVersion: 1;
      commandId: string;
      commandKey: string;
      state: 'received';
    }
  | {
      protocolVersion: 1;
      commandId: string;
      commandKey: string;
      state: 'settled';
      reply: ControlReply;
    };

const MAX_CONTROL_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_CONTROL_JOURNAL_RECORDS = 10_000;

function journalCommandKind(commandKey: string): ControlRequest['kind'] | undefined {
  try {
    const parsed: unknown = JSON.parse(commandKey);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const kind = (parsed as Record<string, unknown>).kind;
    return kind === 'steer' || kind === 'cancel' || kind === 'answer-permission' ? kind : undefined;
  } catch {
    return undefined;
  }
}

function isControlReply(
  value: unknown,
  expectedCommandId: string,
  commandKey: string,
): value is ControlReply {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const commandKind = journalCommandKind(commandKey);
  return (
    (record.kind === 'ack' &&
      record.commandId === expectedCommandId &&
      ((commandKind === 'steer' &&
        typeof record.injected === 'boolean' &&
        record.applied === undefined) ||
        ((commandKind === 'cancel' || commandKind === 'answer-permission') &&
          typeof record.applied === 'boolean' &&
          record.injected === undefined))) ||
    (record.kind === 'reject' &&
      record.commandId === expectedCommandId &&
      ['stale-lease', 'wrong-turn', 'command-conflict', 'ambiguous', 'handler-error'].includes(
        String(record.reason),
      ))
  );
}

async function openControlJournal(journalPath: string): Promise<{
  entries: Map<string, JournalEntry>;
  append(record: DurableJournalRecord): Promise<void>;
  close(): Promise<void>;
}> {
  const handle = await open(
    journalPath,
    constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    // `handle.sync()` below makes record contents durable, while syncing the parent
    // makes a newly-created journal directory entry durable before any effect may run.
    const parent = await open(dirname(journalPath), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_CONTROL_JOURNAL_BYTES) {
      throw new Error('control journal is not a bounded regular file');
    }
    const bytes = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error('control journal ended during read');
      offset += bytesRead;
    }
    let completeLength = bytes.length;
    if (bytes.length > 0 && bytes.at(-1) !== LF) {
      const lastLf = bytes.lastIndexOf(LF);
      completeLength = lastLf + 1;
      // A crash can tear only the final append. Truncate that suffix and sync the
      // repair. A torn `received` never preceded an effect; a torn `settled` leaves
      // its earlier complete `received` record and therefore recovers as ambiguous.
      await handle.truncate(completeLength);
      await handle.sync();
    }
    const text = bytes.subarray(0, completeLength).toString('utf8');
    const lines = text.length === 0 ? [] : text.slice(0, -1).split('\n');
    if (lines.length > MAX_CONTROL_JOURNAL_RECORDS) {
      throw new Error('control journal has too many records');
    }
    const durable = new Map<string, { commandKey: string; reply?: ControlReply }>();
    for (const line of lines) {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('control journal contains an invalid record');
      }
      const record = parsed as Record<string, unknown>;
      if (
        record.protocolVersion !== 1 ||
        typeof record.commandId !== 'string' ||
        record.commandId.length === 0 ||
        typeof record.commandKey !== 'string' ||
        (record.state !== 'received' && record.state !== 'settled')
      ) {
        throw new Error('control journal contains an invalid record');
      }
      const existing = durable.get(record.commandId);
      if (existing !== undefined && existing.commandKey !== record.commandKey) {
        throw new Error('control journal contains a command conflict');
      }
      if (record.state === 'settled') {
        if (!isControlReply(record.reply, record.commandId, record.commandKey)) {
          throw new Error('control journal contains an invalid reply');
        }
        durable.set(record.commandId, { commandKey: record.commandKey, reply: record.reply });
      } else if (existing === undefined) {
        durable.set(record.commandId, { commandKey: record.commandKey });
      }
    }
    const entries = new Map<string, JournalEntry>();
    for (const [commandId, record] of durable) {
      entries.set(commandId, {
        commandKey: record.commandKey,
        reply: Promise.resolve(record.reply ?? { kind: 'reject', commandId, reason: 'ambiguous' }),
      });
    }
    let appendTail = Promise.resolve();
    let recordCount = lines.length;
    let reservedSettlements = 0;
    let poisoned = false;
    return {
      entries,
      append(record): Promise<void> {
        const appended = appendTail.then(async () => {
          try {
            if (poisoned) throw new Error('control journal is unavailable after an append failure');
            const exceedsLimit =
              record.state === 'received'
                ? recordCount + reservedSettlements + 2 > MAX_CONTROL_JOURNAL_RECORDS
                : reservedSettlements < 1 ||
                  recordCount + reservedSettlements > MAX_CONTROL_JOURNAL_RECORDS;
            if (exceedsLimit) {
              throw new Error('control journal record limit exceeded');
            }
            await appendControlJournal(handle, record);
            recordCount += 1;
            if (record.state === 'received') reservedSettlements += 1;
          } catch (error) {
            // A write may have reached the file only partially or reached the page
            // cache before `sync()` failed. Never append another newline after that
            // uncertain suffix: keep it last so restart can truncate it safely.
            poisoned = true;
            throw error;
          } finally {
            if (record.state === 'settled') reservedSettlements -= 1;
          }
        });
        appendTail = appended.catch(() => undefined);
        return appended;
      },
      async close(): Promise<void> {
        await appendTail;
        await handle.close();
      },
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function appendControlJournal(
  handle: FileHandle,
  record: DurableJournalRecord,
): Promise<void> {
  const line = `${JSON.stringify(record)}\n`;
  const bytes = Buffer.from(line);
  const stats = await handle.stat();
  if (stats.size + bytes.length > MAX_CONTROL_JOURNAL_BYTES) {
    throw new Error('control journal size limit exceeded');
  }
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    if (bytesWritten === 0) throw new Error('control journal write made no progress');
    offset += bytesWritten;
  }
  await handle.sync();
}

/**
 * Serve a reconnect-safe control socket for one live turn. The command journal is
 * shared by every connection accepted by this server, including reconnects.
 */
export async function serveControl(
  socketPath: string,
  handlers: ControlHandlers,
  opts: {
    turnId?: string;
    signal?: AbortSignal;
    authorizeAcquire?: (
      requestedControllerId: string,
      current: { controllerId: string; leaseEpoch: number } | undefined,
      capability: string | undefined,
    ) => boolean | Promise<boolean>;
    /** ADR 0006 D6: produce the attach-handshake snapshot (last durable frameSeq,
     * turn status, outstanding permissions, protocol/instance identity) at attach-ACK
     * time. Called once per successful attach so the reply reflects the CURRENT turn
     * state. Omit it and the reply carries {@link defaultAttachSnapshot}. */
    attachSnapshot?: () => ControlAttachSnapshot | Promise<ControlAttachSnapshot>;
    /** Durable D5 command journal. A `received` record is synced before invoking the
     * external effect; if the Runner dies before its outcome is synced, a restarted
     * control server rejects the same command id as `ambiguous` instead of replaying. */
    journalPath?: string;
  } = {},
): Promise<ControlSocketServer> {
  const turnId = opts.turnId ?? socketPath;
  await mkdir(dirname(socketPath), { recursive: true });
  await rm(socketPath, { force: true });

  const sockets = new Set<Socket>();
  let server!: Server;
  let currentLeaseEpoch = 0;
  let currentControllerId: string | undefined;
  const durableJournal =
    opts.journalPath === undefined ? undefined : await openControlJournal(opts.journalPath);
  const journal = durableJournal?.entries ?? new Map<string, JournalEntry>();
  const attachedEpochs = new WeakMap<Socket, number>();
  let attachTail = Promise.resolve();
  const pendingDeliveries = new Set<Promise<void>>();
  let closing = false;

  const runCommand = (msg: ControlRequest): Promise<ControlReply> => {
    if (msg.leaseEpoch < currentLeaseEpoch) {
      return Promise.resolve({ kind: 'reject', commandId: msg.commandId, reason: 'stale-lease' });
    }
    currentLeaseEpoch = msg.leaseEpoch;

    try {
      switch (msg.kind) {
        case 'steer':
          return Promise.resolve(handlers.steer(msg.message)).then(
            (injected) => ({ kind: 'ack', commandId: msg.commandId, injected }),
            () => ({ kind: 'reject', commandId: msg.commandId, reason: 'handler-error' }),
          );
        case 'cancel':
          return Promise.resolve(handlers.cancel()).then(
            (applied) => ({ kind: 'ack', commandId: msg.commandId, applied }),
            () => ({ kind: 'reject', commandId: msg.commandId, reason: 'handler-error' }),
          );
        case 'answer-permission':
          return Promise.resolve(handlers.answerPermission(msg.toolUseId, msg.decision)).then(
            (applied) => ({ kind: 'ack', commandId: msg.commandId, applied }),
            () => ({ kind: 'reject', commandId: msg.commandId, reason: 'handler-error' }),
          );
      }
    } catch {
      return Promise.resolve({ kind: 'reject', commandId: msg.commandId, reason: 'handler-error' });
    }
  };

  const dispatch =
    (socket: Socket) =>
    (line: string): void => {
      if (closing) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (isAttachRequest(parsed)) {
        attachTail = attachTail
          .then(async () => {
            if (parsed.turnId !== turnId) {
              socket.write(
                encodeLine({ kind: 'attach-reject', turnId: parsed.turnId, reason: 'wrong-turn' }),
              );
              return;
            }
            // Compute compatibility before ANY controller mutation. New clients first
            // `inspect`, then repeat the version on `acquire`; the second check closes
            // the gap if the live Runner changes between those two connections.
            let snapshot: ControlAttachSnapshot;
            try {
              snapshot = (await opts.attachSnapshot?.()) ?? defaultAttachSnapshot();
            } catch {
              snapshot = defaultAttachSnapshot();
            }
            if (
              parsed.protocolVersion !== undefined &&
              parsed.protocolVersion !== snapshot.protocolVersion
            ) {
              socket.write(
                encodeLine({
                  kind: 'attach-reject',
                  turnId: parsed.turnId,
                  reason: 'incompatible-protocol',
                }),
              );
              return;
            }
            if (parsed.mode === 'inspect') {
              socket.write(encodeLine({ kind: 'inspected', turnId, ...snapshot }));
              return;
            }
            if (
              parsed.mode === 'resume' &&
              (currentControllerId !== parsed.controllerId ||
                parsed.leaseEpoch !== currentLeaseEpoch)
            ) {
              socket.write(
                encodeLine({
                  kind: 'attach-reject',
                  turnId: parsed.turnId,
                  reason: 'stale-controller',
                }),
              );
              return;
            }
            if (parsed.mode === 'acquire') {
              const current =
                currentControllerId === undefined
                  ? undefined
                  : { controllerId: currentControllerId, leaseEpoch: currentLeaseEpoch };
              const authorized = await (opts.authorizeAcquire?.(
                parsed.controllerId,
                current,
                parsed.capability,
              ) ?? current === undefined);
              if (!authorized) {
                socket.write(
                  encodeLine({
                    kind: 'attach-reject',
                    turnId: parsed.turnId,
                    reason: 'stale-controller',
                  }),
                );
                return;
              }
              currentLeaseEpoch += 1;
              currentControllerId = parsed.controllerId;
            }
            attachedEpochs.set(socket, currentLeaseEpoch);
            socket.write(
              encodeLine({
                kind: 'attached',
                turnId,
                controllerId: parsed.controllerId,
                leaseEpoch: currentLeaseEpoch,
                ...snapshot,
              }),
            );
          })
          .catch(() => {
            socket.destroy();
          });
        return;
      }
      if (!isControlRequest(parsed)) return;
      const msg = parsed;
      const attachedEpoch = attachedEpochs.get(socket);
      const key = commandKey(msg);
      const existing = journal.get(msg.commandId);
      let reply: Promise<ControlReply>;
      // Fencing also applies to journal lookups. A superseded controller must not
      // receive an old success ACK after a newer lease has taken ownership, even
      // though replaying that command cannot apply its effect twice.
      if (msg.turnId !== turnId) {
        reply = Promise.resolve({
          kind: 'reject',
          commandId: msg.commandId,
          reason: 'wrong-turn',
        });
      } else if (attachedEpoch === undefined || msg.leaseEpoch !== attachedEpoch) {
        reply = Promise.resolve({
          kind: 'reject',
          commandId: msg.commandId,
          reason: 'stale-lease',
        });
      } else if (msg.leaseEpoch < currentLeaseEpoch) {
        reply = Promise.resolve({
          kind: 'reject',
          commandId: msg.commandId,
          reason: 'stale-lease',
        });
      } else if (existing !== undefined && existing.commandKey !== key) {
        reply = Promise.resolve({
          kind: 'reject',
          commandId: msg.commandId,
          reason: 'command-conflict',
        });
      } else {
        if (existing !== undefined) {
          reply = existing.reply;
        } else {
          // Reserve before awaiting the handler so a racing retry observes the same
          // in-flight reply and cannot apply the command twice.
          reply = (async (): Promise<ControlReply> => {
            if (durableJournal !== undefined) {
              try {
                await durableJournal.append({
                  protocolVersion: 1,
                  commandId: msg.commandId,
                  commandKey: key,
                  state: 'received',
                });
              } catch {
                return { kind: 'reject', commandId: msg.commandId, reason: 'handler-error' };
              }
            }
            const value = await runCommand(msg);
            if (durableJournal !== undefined) {
              try {
                await durableJournal.append({
                  protocolVersion: 1,
                  commandId: msg.commandId,
                  commandKey: key,
                  state: 'settled',
                  reply: value,
                });
              } catch {
                return { kind: 'reject', commandId: msg.commandId, reason: 'ambiguous' };
              }
            }
            return value;
          })();
          journal.set(msg.commandId, { commandKey: key, reply });
        }
      }
      const requestEpoch = msg.leaseEpoch;
      const delivery = reply
        .then(
          (value) =>
            new Promise<void>((resolve) => {
              if (socket.destroyed) {
                resolve();
                return;
              }
              // A newer attach can fence this controller while an async handler is still
              // applying. Never emit the old success ACK after takeover.
              const response =
                requestEpoch < currentLeaseEpoch
                  ? {
                      kind: 'reject' as const,
                      commandId: msg.commandId,
                      reason: 'stale-lease' as const,
                    }
                  : value;
              socket.write(encodeLine(response), () => resolve());
            }),
        )
        .catch(() => undefined);
      pendingDeliveries.add(delivery);
      void delivery.finally(() => pendingDeliveries.delete(delivery));
    };

  await new Promise<void>((resolve, reject) => {
    server = createServer((socket) => {
      sockets.add(socket);
      socket.on(
        'data',
        makeLineReader(dispatch(socket), () => socket.destroy()),
      );
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => sockets.delete(socket));
    });
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const close = async (): Promise<void> => {
    if (closing) {
      await closed;
      return;
    }
    closing = true;
    const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
    // A command whose effect has already run must get a bounded chance to deliver its
    // journaled reply. Otherwise turn settlement can destroy the socket between the
    // effect and ACK, forcing the controller to report an ambiguous delivery.
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...pendingDeliveries]),
        new Promise<void>((resolve) => {
          drainTimer = setTimeout(resolve, 1_000);
        }),
      ]);
    } finally {
      clearTimeout(drainTimer);
    }
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await serverClosed;
    await rm(socketPath, { force: true }).catch(() => undefined);
    await durableJournal?.close();
    resolveClosed();
  };

  const signal = opts.signal;
  if (signal !== undefined) {
    if (signal.aborted) void close();
    else signal.addEventListener('abort', () => void close(), { once: true });
  }

  return { socketPath, close, closed };
}

export interface ControlSocketClient {
  readonly turnId: string;
  readonly controllerId: string;
  readonly leaseEpoch: number;
  /** ADR 0006 D6: the turn snapshot reported at attach time (last durable frameSeq,
   * status, outstanding permissions, protocol/instance identity). A recovering
   * controller reads this to decide reattach-vs-settle and re-surface parked prompts. */
  readonly snapshot: ControlAttachSnapshot;
  steer(message: SteerMessage, opts?: ControlCommandOptions): Promise<boolean>;
  cancel(opts?: ControlCommandOptions): Promise<ControlAck>;
  answerPermission(
    toolUseId: string,
    decision: PermissionDecision,
    opts?: ControlCommandOptions,
  ): Promise<ControlAck>;
  close(): void;
}

/** connect(2) rejects unix socket paths longer than `sun_path` (~104-108 bytes).
 * The per-turn control sockets under the Server-visible runners root exceed that
 * (a project uuid plus a turn uuid in the path), while the Runner binds the same
 * socket at a short in-container path — the socket is reachable, just not by its
 * long name. Reference a too-long path through a freshly minted short symlink;
 * the kernel resolves the link at connect time, and the link directory is removed
 * as soon as the connection attempt settles. */
const SUN_PATH_SAFE_BYTES = 100;

async function connectableControlPath(
  socketPath: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  if (Buffer.byteLength(socketPath) <= SUN_PATH_SAFE_BYTES) {
    return { path: socketPath, cleanup: () => Promise.resolve() };
  }
  const dir = await mkdtemp(join(tmpdir(), 'verity-ctl-'));
  const cleanup = (): Promise<void> => rm(dir, { recursive: true, force: true });
  try {
    const short = join(dir, 's.sock');
    await symlink(resolve(socketPath), short);
    return { path: short, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Read-only compatibility preflight. It never acquires or advances a controller
 * lease, so an incompatible candidate Server cannot fence the active controller. */
export async function inspectControl(
  socketPath: string,
  opts: { turnId?: string; protocolVersion?: number; timeoutMs?: number } = {},
): Promise<ControlAttachSnapshot> {
  const turnId = opts.turnId ?? socketPath;
  const protocolVersion = opts.protocolVersion ?? RUNNER_FRAME_PROTOCOL_VERSION;
  const target = await connectableControlPath(socketPath);
  try {
    return await inspectOverPath(target.path, turnId, protocolVersion, opts.timeoutMs);
  } finally {
    await target.cleanup();
  }
}

function inspectOverPath(
  socketPath: string,
  turnId: string,
  protocolVersion: number,
  timeoutMs?: number,
): Promise<ControlAttachSnapshot> {
  return new Promise<ControlAttachSnapshot>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (error?: Error, snapshot?: ControlAttachSnapshot): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error !== undefined) reject(error);
      else resolve(snapshot ?? defaultAttachSnapshot());
    };
    const timeout = setTimeout(
      () => finish(new Error('control inspect timed out')),
      timeoutMs ?? 1_000,
    );
    socket.once('error', (error) => finish(error));
    socket.on(
      'data',
      makeLineReader(
        (line) => {
          try {
            const parsed: unknown = JSON.parse(line);
            if (typeof parsed !== 'object' || parsed === null) return;
            const reply = parsed as ControlAttachReply;
            if (reply.kind === 'attach-reject') {
              finish(new Error(`control inspect rejected: ${reply.reason}`));
            } else if (reply.kind === 'inspected' && reply.turnId === turnId) {
              if (
                reply.protocolVersion !== protocolVersion ||
                !Number.isSafeInteger(reply.lastFrameSeq) ||
                reply.lastFrameSeq < 0 ||
                (reply.turnStatus !== 'running' && reply.turnStatus !== 'settled') ||
                !Array.isArray(reply.outstandingPermissions) ||
                !reply.outstandingPermissions.every(isPermissionRequest)
              ) {
                finish(new Error('control inspect returned an invalid or incompatible snapshot'));
              } else {
                finish(undefined, reply);
              }
            }
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        },
        () => finish(new Error('control inspect response too large')),
      ),
    );
    socket.once('close', () => finish(new Error('control socket closed before inspect completed')));
    socket.once('connect', () => {
      socket.write(
        encodeLine({
          kind: 'attach',
          turnId,
          controllerId: randomUUID(),
          mode: 'inspect',
          protocolVersion,
        }),
      );
    });
  });
}

interface PendingCommand {
  readonly commandKey: string;
  readonly reply: Promise<ControlReply | undefined>;
  readonly resolve: (reply: ControlReply | undefined) => void;
}

/**
 * Connect one controller lease to a live turn. Callers that retry after an
 * ambiguous disconnect pass the original `commandId` to the new client.
 */
export async function connectControl(
  socketPath: string,
  opts: {
    turnId?: string;
    controllerId?: string;
    resumeLeaseEpoch?: number;
    /** Version already validated through the supervisor's immutable turn state.
     * This is the N+1→N compatibility path for control sockets predating `inspect`. */
    verifiedProtocolVersion?: number;
    attachTimeoutMs?: number;
    capability?: string;
  } = {},
): Promise<ControlSocketClient> {
  const turnId = opts.turnId ?? socketPath;
  const controllerId = opts.controllerId ?? randomUUID();
  if (opts.resumeLeaseEpoch !== undefined && !Number.isSafeInteger(opts.resumeLeaseEpoch)) {
    throw new Error('control resumeLeaseEpoch must be a safe integer');
  }
  const attachTimeoutMs = opts.attachTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(attachTimeoutMs) || attachTimeoutMs < 1)
    throw new Error('control attach timeout must be a positive safe integer');

  // Compatibility is established without touching the Runner's controller epoch.
  // `acquire` repeats the version below so the check and lease mutation are atomic.
  if (opts.verifiedProtocolVersion === undefined) {
    await inspectControl(socketPath, { turnId });
  } else if (opts.verifiedProtocolVersion !== RUNNER_FRAME_PROTOCOL_VERSION) {
    throw new Error('control attach has an incompatible verified protocol');
  }

  const target = await connectableControlPath(socketPath);
  let socket: Socket;
  try {
    socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = createConnection(target.path);
      candidate.once('connect', () => {
        candidate.removeListener('error', reject);
        resolve(candidate);
      });
      candidate.once('error', reject);
    });
  } finally {
    await target.cleanup();
  }

  const pending = new Map<string, PendingCommand>();
  let settleAttach!: (reply: ControlAttachReply) => void;
  let rejectAttach!: (error: Error) => void;
  const attached = new Promise<ControlAttachReply>((resolve, reject) => {
    settleAttach = resolve;
    rejectAttach = reject;
  });
  const attachTimer = setTimeout(() => {
    rejectAttach(new Error('control attach timed out'));
    socket.destroy();
  }, attachTimeoutMs);
  socket.on(
    'data',
    makeLineReader(
      (line) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }
        if (typeof parsed !== 'object' || parsed === null) return;
        const reply = parsed as Record<string, unknown>;
        if (reply.kind === 'attached' || reply.kind === 'attach-reject') {
          settleAttach(parsed as ControlAttachReply);
          return;
        }
        if (
          (reply.kind !== 'ack' && reply.kind !== 'reject') ||
          typeof reply.commandId !== 'string'
        ) {
          return;
        }
        const command = pending.get(reply.commandId);
        if (command === undefined) return;
        pending.delete(reply.commandId);
        command.resolve(parsed as ControlReply);
      },
      () => socket.destroy(),
    ),
  );

  const failAllPending = (): void => {
    for (const [commandId, command] of pending) {
      pending.delete(commandId);
      command.resolve(undefined);
    }
  };
  socket.on('close', () => {
    failAllPending();
    rejectAttach(new Error('control socket closed before attach completed'));
  });
  socket.on('error', () => undefined);

  socket.write(
    encodeLine({
      kind: 'attach',
      turnId,
      controllerId,
      mode: opts.resumeLeaseEpoch === undefined ? 'acquire' : 'resume',
      protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
      ...(opts.capability !== undefined ? { capability: opts.capability } : {}),
      ...(opts.resumeLeaseEpoch !== undefined ? { leaseEpoch: opts.resumeLeaseEpoch } : {}),
    }),
  );
  let attachReply: ControlAttachReply;
  try {
    attachReply = await attached;
  } finally {
    clearTimeout(attachTimer);
  }
  if (attachReply.kind === 'attach-reject') {
    socket.destroy();
    throw new Error(`control attach rejected: ${attachReply.reason}`);
  }
  if (attachReply.kind !== 'attached') {
    socket.destroy();
    throw new Error('control attach returned an inspect reply');
  }
  if (attachReply.turnId !== turnId || attachReply.controllerId !== controllerId) {
    socket.destroy();
    throw new Error('control attach identity mismatch');
  }
  if (!Number.isSafeInteger(attachReply.leaseEpoch) || attachReply.leaseEpoch < 1) {
    socket.destroy();
    throw new Error('control attach returned an invalid lease epoch');
  }
  const leaseEpoch = attachReply.leaseEpoch;
  // D6 snapshot from the ACK. Defensive: a peer that predates the handshake fields
  // (N/N−1) yields an undefined/partial snapshot; fall back to the running default so
  // an older Runner still attaches rather than the client throwing on a missing field.
  const snapshot: ControlAttachSnapshot =
    Number.isSafeInteger(attachReply.lastFrameSeq) &&
    attachReply.lastFrameSeq >= 0 &&
    (attachReply.turnStatus === 'running' || attachReply.turnStatus === 'settled')
      ? {
          protocolVersion:
            typeof attachReply.protocolVersion === 'number'
              ? attachReply.protocolVersion
              : RUNNER_FRAME_PROTOCOL_VERSION,
          ...(typeof attachReply.runnerInstanceId === 'string'
            ? { runnerInstanceId: attachReply.runnerInstanceId }
            : {}),
          lastFrameSeq: attachReply.lastFrameSeq,
          turnStatus: attachReply.turnStatus,
          outstandingPermissions: Array.isArray(attachReply.outstandingPermissions)
            ? attachReply.outstandingPermissions
            : [],
        }
      : defaultAttachSnapshot();

  const request = (msg: ControlRequest): Promise<ControlReply | undefined> => {
    if (socket.destroyed) return Promise.resolve(undefined);
    const key = commandKey(msg);
    const existing = pending.get(msg.commandId);
    if (existing !== undefined) {
      return existing.commandKey === key
        ? existing.reply
        : Promise.resolve({
            kind: 'reject',
            commandId: msg.commandId,
            reason: 'command-conflict',
          });
    }
    let resolveReply!: (reply: ControlReply | undefined) => void;
    const reply = new Promise<ControlReply | undefined>((resolve) => {
      resolveReply = resolve;
    });
    pending.set(msg.commandId, { commandKey: key, reply, resolve: resolveReply });
    socket.write(encodeLine(msg));
    return reply;
  };
  const commandId = (commandOpts?: ControlCommandOptions): string =>
    commandOpts?.commandId ?? randomUUID();
  const ack = (requestedCommandId: string, reply: ControlReply | undefined): ControlAck => {
    if (reply === undefined) {
      return { commandId: requestedCommandId, applied: false, reason: 'unreachable' };
    }
    if (reply.kind === 'reject') {
      return { commandId: reply.commandId, applied: false, reason: reply.reason };
    }
    // Cancel and permission commands are successful only when the Runner explicitly
    // confirms that their handler applied them. A bare/legacy ACK proves correlation,
    // not delivery to the live turn; treating a missing `applied` as true can make the
    // Server clear a parked permission and return 200 without unblocking the worker.
    return { commandId: reply.commandId, applied: reply.applied === true };
  };

  return {
    turnId,
    controllerId,
    leaseEpoch,
    snapshot,
    steer: async (message, commandOpts) => {
      const id = commandId(commandOpts);
      const reply = await request({
        kind: 'steer',
        turnId,
        commandId: id,
        leaseEpoch,
        message,
      });
      if (reply === undefined) throw new ControlDeliveryUnknownError(id);
      if (reply.kind === 'reject') {
        if (reply.reason === 'handler-error') throw new ControlDeliveryUnknownError(id);
        throw new ControlCommandRejectedError(id, reply.reason);
      }
      return reply?.kind === 'ack' && reply.injected === true;
    },
    cancel: async (commandOpts) => {
      const id = commandId(commandOpts);
      return ack(
        id,
        await request({
          kind: 'cancel',
          turnId,
          commandId: id,
          leaseEpoch,
        }),
      );
    },
    answerPermission: async (toolUseId, decision, commandOpts) => {
      const id = commandId(commandOpts);
      return ack(
        id,
        await request({
          kind: 'answer-permission',
          turnId,
          commandId: id,
          leaseEpoch,
          toolUseId,
          decision,
        }),
      );
    },
    close: () => {
      failAllPending();
      socket.destroy();
    },
  };
}
