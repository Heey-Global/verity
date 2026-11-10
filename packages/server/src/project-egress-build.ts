import { z } from 'zod';
import {
  describeProtectedBuildFailure,
  ProtectedBuildFailure,
  type ProtectedBuildFailureDescription,
} from './project-egress-build-error.js';

const identity = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u);
export const protectedBuildRequest = z.strictObject({
  projectId: identity,
  attemptId: z.uuid(),
  snapshot: z.string().regex(/^attempt-[a-zA-Z0-9_-]{1,64}\/verity-build-[a-zA-Z0-9_-]{1,64}$/u),
  image: z.string().regex(/^verity-devc-[a-z0-9][a-z0-9_.-]{0,200}:[a-f0-9]{12}$/u),
  noCache: z.boolean(),
});
export type ProtectedBuildRequest = z.infer<typeof protectedBuildRequest>;
type ProtectedBuildPhase = 'preparing' | 'running' | 'succeeded' | 'failed' | 'stopping';
export interface ProtectedBuildRecord {
  request: ProtectedBuildRequest;
  phase: ProtectedBuildPhase;
  /** A failed operation remains allocated until the host confirms process termination. */
  ended: boolean;
  /** Resources were removed after termination was proven; safe to retry after a crash. */
  cleaned?: boolean | undefined;
}
export interface ProtectedBuildRuntime {
  ready(this: void): Promise<boolean>;
  /** Prepare an isolated, denied attempt. Must not run project input. */
  prepare(this: void, request: ProtectedBuildRequest): Promise<void>;
  /** Inspect the exact live attachment and renew its project-derived packet authority. */
  renew(this: void, request: ProtectedBuildRequest): Promise<void>;
  /** Start the fixed CLI/daemon/worker contract only, never caller-supplied commands. */
  start(this: void, request: ProtectedBuildRequest): Promise<void>;
  status(this: void, request: ProtectedBuildRequest): Promise<'running' | 'succeeded' | 'failed'>;
  /** Revoke packets before asking the supervisor to terminate the whole attempt cgroup. */
  deny(this: void, request: ProtectedBuildRequest): Promise<void>;
  stop(this: void, request: ProtectedBuildRequest): Promise<void>;
  ended(this: void, request: ProtectedBuildRequest): Promise<boolean>;
  remove(this: void, request: ProtectedBuildRequest): Promise<void>;
}
export const protectedBuildRecord = z.strictObject({
  request: protectedBuildRequest,
  phase: z.enum(['preparing', 'running', 'succeeded', 'failed', 'stopping']),
  ended: z.boolean(),
  cleaned: z.boolean().optional(),
});
export const protectedBuildCommand = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('health') }),
  z.strictObject({ operation: z.literal('slot') }),
  z.strictObject({ operation: z.literal('begin'), request: protectedBuildRequest }),
  ...(['heartbeat', 'status', 'cancel'] as const).map((operation) =>
    z.strictObject({
      operation: z.literal(operation),
      projectId: identity,
      attemptId: z.uuid(),
    }),
  ),
]);
export const protectedBuildReply = z.union([
  z.strictObject({ version: z.literal(1), available: z.boolean() }),
  /** The single host slot holds no build whose termination is unproven. */
  z.strictObject({ version: z.literal(1), idle: z.boolean() }),
  z.strictObject({ version: z.literal(1), record: protectedBuildRecord }),
]);
export type ProtectedBuildCommand = z.infer<typeof protectedBuildCommand>;
export type ProtectedBuildReply = z.infer<typeof protectedBuildReply>;
// Every field is a primitive; derive the keys from the schema so a new field
// cannot silently drop out of receipt, acknowledgement or termination matching.
const requestKeys = Object.keys(protectedBuildRequest.shape) as (keyof ProtectedBuildRequest)[];
export const sameProtectedBuildRequest = (a: ProtectedBuildRequest, b: ProtectedBuildRequest) =>
  requestKeys.every((key) => a[key] === b[key]);
const same = sameProtectedBuildRequest;
const terminal = (phase: ProtectedBuildPhase) => phase === 'failed' || phase === 'succeeded';
/** Host journal entry for a failed lifecycle step, correlated to its attempt. */
export interface ProtectedBuildEvent {
  event: 'cleanup_failed' | 'cleanup_recovered' | 'begin_refused';
  projectId: string;
  attemptId: string;
  /** The attempt whose cleanup blocks the slot, when it differs from the request. */
  blockingAttemptId?: string;
  operation: 'begin' | 'restore' | 'revalidate' | 'heartbeat' | 'status' | 'cancel' | 'close';
  reason?: string;
  failures?: number;
  retryInMs?: number;
  failure?: ProtectedBuildFailureDescription;
}
const CLEANUP_RETRY_MIN_MS = 1000;
const CLEANUP_RETRY_MAX_MS = 5 * 60_000;
const defaultReport = (event: ProtectedBuildEvent) =>
  console.warn('verity: protected build lifecycle', JSON.stringify(event));

/** Host-owned build lifecycle, separate from the project's live sandbox generation.
 * There is one host build slot. Reads never renew it; only an authenticated Server
 * heartbeat does. Packet authority must expire independently in the kernel.
 */
export class ProtectedBuildHost {
  private record: ProtectedBuildRecord | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private lastHeartbeat = 0;
  /** A persisted record was loaded at startup. The host keeps its last record once
   * it has run any build, so missing state (fresh or wiped directory) cannot prove
   * that builds from before it ended; such a host never reports its slot idle. */
  private restoredFromState = false;
  /** Consecutive cleanup failures of the current ended record; in memory only,
   * so a restart retries at once. Never persisted as evidence of anything. */
  private cleanupFailures = 0;
  private cleanupRetryAt = 0;
  private operation: ProtectedBuildEvent['operation'] = 'revalidate';
  constructor(
    private readonly runtime: ProtectedBuildRuntime,
    private readonly persist: (record: ProtectedBuildRecord | undefined) => Promise<void>,
    private readonly now: () => number = () => performance.now(),
    private readonly receipts?: {
      save(record: ProtectedBuildRecord): Promise<void>;
      load(projectId: string, attemptId: string): Promise<ProtectedBuildRecord | undefined>;
    },
    private readonly report: (event: ProtectedBuildEvent) => void = defaultReport,
  ) {}
  private serialize<T>(
    work: () => Promise<T>,
    operation: ProtectedBuildEvent['operation'] = 'revalidate',
  ): Promise<T> {
    const pending = this.queue.then(() => {
      this.operation = operation;
      return work();
    });
    this.queue = pending.catch(() => undefined);
    return pending;
  }
  async execute(input: unknown): Promise<ProtectedBuildReply> {
    const command = protectedBuildCommand.parse(input);
    if (command.operation === 'health')
      return { version: 1, available: !this.closed && (await this.runtime.ready()) };
    if (command.operation === 'slot')
      return {
        version: 1,
        idle: await this.serialize(() =>
          Promise.resolve(this.restoredFromState && (this.record?.ended ?? true)),
        ),
      };
    if (command.operation === 'begin')
      return { version: 1, record: await this.begin(command.request) };
    if (command.operation === 'cancel')
      return { version: 1, record: await this.cancel(command.projectId, command.attemptId) };
    if (command.operation === 'heartbeat')
      await this.heartbeat(command.projectId, command.attemptId);
    return { version: 1, record: await this.status(command.projectId, command.attemptId) };
  }
  private async save() {
    await this.persist(this.record && structuredClone(this.record));
  }
  private match(projectId: string, attemptId: string): ProtectedBuildRecord {
    const record = this.record;
    if (!record || record.request.projectId !== projectId || record.request.attemptId !== attemptId)
      throw new ProtectedBuildFailure('unknown_attempt');
    return record;
  }
  private async receipt(projectId: string, attemptId: string): Promise<ProtectedBuildRecord> {
    const value = await this.receipts?.load(projectId, attemptId);
    if (value === undefined) throw new ProtectedBuildFailure('unknown_attempt');
    const record = protectedBuildRecord.parse(value);
    if (
      !record.ended ||
      !terminal(record.phase) ||
      record.request.projectId !== projectId ||
      record.request.attemptId !== attemptId
    )
      throw new ProtectedBuildFailure('unknown_attempt');
    return record;
  }
  private async cleanup(record: ProtectedBuildRecord): Promise<void> {
    if (!record.ended || record.cleaned) return;
    try {
      // Keep authenticated termination proof even if removal or a later build fails.
      await this.receipts?.save(structuredClone(record));
      await this.runtime.remove(record.request);
    } catch (cause) {
      this.cleanupFailures++;
      const retryInMs = Math.min(
        CLEANUP_RETRY_MAX_MS,
        CLEANUP_RETRY_MIN_MS * 2 ** Math.min(this.cleanupFailures - 1, 20),
      );
      this.cleanupRetryAt = this.now() + retryInMs;
      this.report({
        event: 'cleanup_failed',
        projectId: record.request.projectId,
        attemptId: record.request.attemptId,
        operation: this.operation,
        failures: this.cleanupFailures,
        retryInMs,
        failure: describeProtectedBuildFailure(cause),
      });
      throw new ProtectedBuildFailure('cleanup_failed', { cause });
    }
    record.cleaned = true;
    if (this.cleanupFailures > 0)
      this.report({
        event: 'cleanup_recovered',
        projectId: record.request.projectId,
        attemptId: record.request.attemptId,
        operation: this.operation,
        failures: this.cleanupFailures,
      });
    this.cleanupFailures = 0;
    this.cleanupRetryAt = 0;
    // Removal is idempotent; an unpersisted flag only repeats it after a restart.
    await this.save();
  }
  /** A refused begin never started anything for its attempt: no state, anchor,
   * unit or rule was created for it. Record that as a terminal receipt, so the
   * Server's storage reservation for it can be released on host evidence instead
   * of remaining held behind `unknown_attempt` forever. */
  private async refuse(
    request: ProtectedBuildRequest,
    failure: ProtectedBuildFailure,
  ): Promise<never> {
    this.report({
      event: 'begin_refused',
      projectId: request.projectId,
      attemptId: request.attemptId,
      ...(this.record ? { blockingAttemptId: this.record.request.attemptId } : {}),
      operation: 'begin',
      reason: failure.reason,
      ...(failure.cause === undefined
        ? {}
        : { failure: describeProtectedBuildFailure(failure.cause) }),
    });
    try {
      await this.receipts?.save({ request, phase: 'failed', ended: true, cleaned: true });
    } catch (cause) {
      throw new ProtectedBuildFailure(failure.reason, {
        cause: new AggregateError([failure, cause]),
      });
    }
    throw failure;
  }
  private async contain(record: ProtectedBuildRecord): Promise<void> {
    if (record.ended) {
      await this.settle(record);
      return;
    }
    record.phase = 'stopping';
    // Persistence failure does not skip packet revocation or process containment.
    const saved = await Promise.allSettled([this.save(), this.runtime.deny(record.request)]);
    let stopped: unknown;
    try {
      await this.runtime.stop(record.request);
    } catch (error) {
      stopped = error;
    }
    record.ended = await this.runtime.ended(record.request).catch(() => false);
    if (record.ended) record.phase = 'failed';
    await this.save();
    // Termination is proven; a failed removal is retried by the host sweep and
    // must not replace the original failure or block a restart.
    if (record.ended) await this.settle(record);
    const errors = saved.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
    if (stopped !== undefined) errors.push(stopped);
    if (errors.length)
      throw new ProtectedBuildFailure('containment_failed', { cause: new AggregateError(errors) });
  }
  /** Restore before accepting requests; never resume old access or unknown processes. */
  restore(value: unknown): Promise<void> {
    return this.serialize(async () => {
      if (this.record) throw new Error('Protected build state is already loaded');
      if (value === undefined) return;
      const parsed = protectedBuildRecord.parse(value);
      // Interrupted records can claim termination without a terminal outcome.
      // Recontain them before issuing a receipt; neither flag proves cleanup.
      if (!terminal(parsed.phase)) {
        parsed.ended = false;
        parsed.cleaned = false;
      }
      this.record = parsed;
      this.restoredFromState = true;
      this.cleanupFailures = 0;
      this.cleanupRetryAt = 0;
      // An ended record whose removal keeps failing must not stop the host from
      // starting: every later begin and sweep retries it, with diagnostics.
      if (parsed.ended) await this.settle(parsed);
      else await this.contain(parsed);
    }, 'restore');
  }
  begin(input: unknown): Promise<ProtectedBuildRecord> {
    const request = protectedBuildRequest.parse(input);
    return this.serialize(async () => {
      if (this.closed) throw new Error('Protected build service is closed');
      if (this.record?.request.attemptId === request.attemptId) {
        if (!same(this.record.request, request)) throw new ProtectedBuildFailure('attempt_changed');
        return structuredClone(this.record);
      }
      // A terminal receipt, including a refusal, answers a retried begin.
      const previous = await this.receipts?.load(request.projectId, request.attemptId);
      if (previous) {
        const recorded = await this.receipt(request.projectId, request.attemptId);
        if (!same(recorded.request, request)) throw new ProtectedBuildFailure('attempt_changed');
        return structuredClone(recorded);
      }
      if (this.record) {
        if (!this.record.ended) await this.refuse(request, new ProtectedBuildFailure('slot_busy'));
        try {
          await this.cleanup(this.record);
        } catch (cause) {
          await this.refuse(
            request,
            cause instanceof ProtectedBuildFailure
              ? cause
              : new ProtectedBuildFailure('cleanup_failed', { cause }),
          );
        }
      }
      const record: ProtectedBuildRecord = { request, phase: 'preparing', ended: false };
      this.record = record;
      // A crash before preparation still leaves an owned attempt for restoration.
      await this.save();
      try {
        await this.runtime.prepare(request).catch((cause: unknown) => {
          throw cause instanceof ProtectedBuildFailure
            ? cause
            : new ProtectedBuildFailure('prepare_failed', { cause });
        });
        await this.runtime.renew(request).catch((cause: unknown) => {
          throw new ProtectedBuildFailure('renew_failed', { cause });
        });
        await this.runtime.start(request).catch((cause: unknown) => {
          throw new ProtectedBuildFailure('launch_failed', { cause });
        });
        record.phase = 'running';
        this.lastHeartbeat = this.now();
        await this.save();
        return structuredClone(record);
      } catch (cause) {
        try {
          await this.contain(record);
        } catch (error) {
          throw new ProtectedBuildFailure(
            cause instanceof ProtectedBuildFailure ? cause.reason : 'prepare_failed',
            { cause: new AggregateError([cause, error]) },
          );
        }
        throw cause;
      }
    }, 'begin');
  }
  heartbeat(projectId: string, attemptId: string): Promise<void> {
    return this.serialize(async () => {
      if (this.closed) throw new Error('Protected build service is closed');
      const record = this.match(projectId, attemptId);
      if (record.phase !== 'running') throw new Error('Protected build is not running');
      try {
        await this.runtime.renew(record.request);
        this.lastHeartbeat = this.now();
      } catch (cause) {
        try {
          await this.contain(record);
        } catch (error) {
          throw new ProtectedBuildFailure('renew_failed', {
            cause: new AggregateError([cause, error]),
          });
        }
        throw new ProtectedBuildFailure('renew_failed', { cause });
      }
    }, 'heartbeat');
  }
  /** Host supervisor sweep: abandoned clients cannot retain the build slot
   * forever. This does not refresh packet authority; only heartbeat does that.
   */
  revalidate(): Promise<void> {
    return this.serialize(async () => {
      const record = this.record;
      if (!record) return;
      if (record.ended) {
        // Each failure is reported with its attempt and stage by cleanup().
        if (!record.cleaned && this.now() < this.cleanupRetryAt) return;
        await this.settle(record);
        return;
      }
      if (record.phase === 'running' && this.now() - this.lastHeartbeat > 5000) {
        await this.contain(record);
        return;
      }
      await this.poll(record);
    });
  }
  /** Termination is already proven here; the host sweep retries removal, so a
   * cleanup failure must not turn a status read (or a succeeded build) into an error. */
  private async settle(record: ProtectedBuildRecord): Promise<void> {
    await this.cleanup(record).catch(() => undefined);
  }
  private async poll(record: ProtectedBuildRecord): Promise<void> {
    if (record.phase === 'stopping') {
      record.ended = await this.runtime.ended(record.request);
      if (record.ended) {
        record.phase = 'failed';
        await this.save();
        await this.settle(record);
      }
    }
    if (!terminal(record.phase) && record.phase !== 'stopping') {
      const phase = await this.runtime.status(record.request);
      if (phase !== 'running') {
        await this.runtime.deny(record.request);
        await this.runtime.stop(record.request);
        record.ended = await this.runtime.ended(record.request);
        record.phase = record.ended ? phase : 'stopping';
        await this.save();
        if (record.ended) await this.settle(record);
      }
    }
  }
  status(projectId: string, attemptId: string): Promise<ProtectedBuildRecord> {
    return this.serialize(async () => {
      if (
        this.record?.request.projectId !== projectId ||
        this.record.request.attemptId !== attemptId
      )
        return structuredClone(await this.receipt(projectId, attemptId));
      const record = this.match(projectId, attemptId);
      await this.poll(record);
      return structuredClone(record);
    }, 'status');
  }
  cancel(projectId: string, attemptId: string): Promise<ProtectedBuildRecord> {
    return this.serialize(async () => {
      if (
        this.record?.request.projectId !== projectId ||
        this.record.request.attemptId !== attemptId
      )
        return structuredClone(await this.receipt(projectId, attemptId));
      const record = this.match(projectId, attemptId);
      if (!record.ended) await this.contain(record);
      return structuredClone(record);
    }, 'cancel');
  }
  close(): Promise<void> {
    this.closed = true;
    return this.serialize(async () => {
      if (this.record) await this.contain(this.record);
    }, 'close');
  }
}
