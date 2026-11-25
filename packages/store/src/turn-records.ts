import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { ABANDONED_TURN_FENCE_HASH } from './event-writes.js';
import type { Database, QueuedTurnOpts } from './schema.js';

/** A turn persisted in the durable backlog (issue #80): its retract handle, the
 * session it belongs to, the prompt, and the per-turn options (attachments as
 * content-addressed refs). `seq` is the FIFO order the conductor recovers them in. */
export interface QueuedTurnRecord {
  id: string;
  seq: number;
  sessionId: string;
  prompt: string;
  opts: QueuedTurnOpts;
}

/** A queued turn minus the `seq` the
 * database assigns. */
export type QueuedTurnInput = Omit<QueuedTurnRecord, 'seq'>;

/** The durable "a turn is in flight for this session" marker (lifecycle Phase 1).
 * Written before a turn launches, cleared on its terminal event; a record still
 * present at startup means the turn was abandoned by a crash/restart. */
export interface RunningTurnRecord {
  markerId?: string | null;
  sessionId: string;
  /** Seq of the prompt event this turn is executing — recovery/reattach anchor. */
  promptSeq: number;
  startedAt: Date;
  /** ADR 0006 Stage 4: the Server-allocated turn id bound before launch (D2), or
   * null before an attempt binds it / on the loopback path. Recovery discovers the
   * turn on the supervisor by this id. */
  turnId: string | null;
  /** ADR 0006 Stage 4: the idempotency key for this turn's StartTurn (D2), or null
   * as for {@link turnId}. Recovery repeats StartTurn under it. */
  startCommandId: string | null;
}

/** Local identities are evidence to compare, never an ownership assignment. */
export interface RunnerTurnOwnershipRequest {
  turnId: string;
  startCommandId?: string;
  runnerInstanceId?: string;
}

/** Ownership does not assert that a turn has settled or that its cache is idle. */
export interface RunnerTurnOwnership {
  turnId: string;
  sessionId?: string;
  conflict: boolean;
}

export class TurnRecordStore {
  constructor(
    private readonly getDb: () => Kysely<Database>,
    private readonly isSessionDeleting: (id: string) => Promise<boolean>,
  ) {}

  private get db(): Kysely<Database> {
    return this.getDb();
  }

  /**
   * Persist one queued turn to the durable backlog (issue #80). The conductor
   * mirrors its in-memory FIFO queue here so a turn sent while the session was busy
   * survives a server restart. The bigserial `seq` is assigned by the database and
   * fixes the FIFO order; `id` is the conductor-minted retract handle.
   */
  async enqueueTurn(input: QueuedTurnInput): Promise<void> {
    await this.db
      .insertInto('queued_turns')
      .values({
        id: input.id,
        session_id: input.sessionId,
        prompt: input.prompt,
        opts: JSON.stringify(input.opts),
      })
      .execute();
  }

  /**
   * Remove one queued turn from the durable backlog by its `id` — called when the
   * turn dispatches (drained as the session goes idle) or the operator retracts it
   * (issue #80). Returns `true` if a row matched, `false` if it was already gone (a
   * harmless no-op: e.g. a retract racing the drain that just dispatched it).
   */
  async deleteQueuedTurn(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom('queued_turns').where('id', '=', id).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  /** Remove a backlog snapshot atomically: either every queued row is deleted or
   * none is. Stop uses this so a storage failure cannot leave a partially deleted
   * backlog split between live memory and durable recovery. */
  async deleteQueuedTurns(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.transaction().execute(async (tx) => {
      for (const id of ids) {
        await tx.deleteFrom('queued_turns').where('id', '=', id).execute();
      }
    });
  }

  /**
   * Read the entire durable backlog across all sessions in FIFO order, for the
   * conductor to rebuild its in-memory queues on startup (issue #80). Ordered by
   * `seq` so each session's turns recover in the order they were enqueued.
   */
  async listQueuedTurns(): Promise<QueuedTurnRecord[]> {
    const rows = await this.db
      .selectFrom('queued_turns')
      .select(['id', 'seq', 'session_id', 'prompt', 'opts'])
      .orderBy('seq', 'asc')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      seq: Number(row.seq),
      sessionId: row.session_id,
      prompt: row.prompt,
      opts: row.opts,
    }));
  }

  /** Mark a turn in flight for `sessionId` (upsert — only one turn runs at a time).
   * Recovery reads these at startup: a marker still present means the turn was
   * abandoned by a crash/restart and must be settled rather than re-inferred. */
  async markTurnRunning(input: {
    sessionId: string;
    promptSeq: number;
    markerId?: string;
  }): Promise<void> {
    if (await this.isSessionDeleting(input.sessionId)) throw new Error('Session is being deleted');
    const markerId = input.markerId ?? randomUUID();
    await this.db
      .insertInto('running_turns')
      .values({
        session_id: input.sessionId,
        prompt_seq: input.promptSeq,
        marker_id: markerId,
        settled: false,
      })
      .onConflict((oc) =>
        oc.column('session_id').doUpdateSet({
          prompt_seq: input.promptSeq,
          marker_id: markerId,
          settled: false,
          started_at: sql`now()`,
          // Re-anchoring the marker (a resume-retry starts a FRESH attempt) drops the
          // previous attempt's bound identity — the new attempt rebinds via
          // {@link bindTurnIdentity} before its Runner launches (ADR 0006 D2). Leaving
          // the stale turn_id would let recovery discover the wrong (superseded) turn.
          turn_id: null,
          start_command_id: null,
        }),
      )
      .execute();
  }

  /** Record backend-confirmed completion, independently of best-effort cleanup.
   * A unique marker identity prevents late completion from settling a resumed
   * attempt even when that attempt reuses the same prompt sequence. The Runner identity must match too; alternatively admission can use
   * its durable terminal/fence claim. */
  async confirmTurnSettled(
    sessionId: string,
    promptSeq: number,
    markerId: string,
    turnId: string | null = null,
  ): Promise<void> {
    await this.db
      .updateTable('running_turns')
      .set({ settled: true })
      .where('session_id', '=', sessionId)
      .where('prompt_seq', '=', promptSeq)
      .where('marker_id', '=', markerId)
      .where('turn_id', turnId === null ? 'is' : '=', turnId)
      .execute();
  }

  /** ADR 0006 Stage 4: bind the Server-allocated turn identity onto the in-flight
   * marker BEFORE the Runner launches (D2), so recovery can discover the turn on the
   * Sandbox supervisor and repeat its idempotent StartTurn. Scoped to `sessionId`
   * (one turn runs at a time under the session lock); a no-op if the marker is gone.
   * Best-effort like {@link markTurnRunning} — never on the turn's critical path. */
  async bindTurnIdentity(
    sessionId: string,
    identity: { turnId: string; startCommandId: string },
  ): Promise<void> {
    await this.db
      .updateTable('running_turns')
      .set({ turn_id: identity.turnId, start_command_id: identity.startCommandId, settled: false })
      .where('session_id', '=', sessionId)
      .execute();
  }

  /** Clear the in-flight marker for `sessionId` once its turn reaches a terminal
   * event. Idempotent — a no-op if no marker is present. When `promptSeq` is given,
   * the delete is SCOPED to that anchor (`prompt_seq = ?`), so a settling turn's
   * late clear can only remove ITS OWN marker, never a newer turn's marker that
   * already replaced the row (the settle-vs-next-turn race). `markerId` additionally
   * distinguishes attempts reusing a prompt anchor; snapshots of legacy markers
   * pass null. Omitting both scopes is reserved for deliberate unconditional cleanup. */
  async clearRunningTurn(
    sessionId: string,
    promptSeq?: number,
    markerId?: string | null,
  ): Promise<void> {
    let query = this.db.deleteFrom('running_turns').where('session_id', '=', sessionId);
    if (promptSeq !== undefined) {
      query = query.where('prompt_seq', '=', promptSeq);
    }
    if (markerId !== undefined)
      query =
        markerId === null
          ? query.where('marker_id', 'is', null)
          : query.where('marker_id', '=', markerId);
    await query.execute();
  }

  /** Resolve a bounded maintenance page against Server-owned execution records.
   * The caller derives sessionIds from the runtime's authoritative routing, including
   * dedicated control-plane routing. Query all owners before applying that scope:
   * filtering first would hide a conflicting binding in another runtime. */
  async resolveRunnerTurnOwnership(input: {
    sessionIds: string[];
    turns: RunnerTurnOwnershipRequest[];
  }): Promise<RunnerTurnOwnership[]> {
    const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
    if (
      input.sessionIds.length > 512 ||
      input.turns.length > 512 ||
      input.sessionIds.some((id) => !safeId.test(id)) ||
      new Set(input.sessionIds).size !== input.sessionIds.length ||
      new Set(input.turns.map((turn) => turn.turnId)).size !== input.turns.length ||
      input.turns.some(
        (turn) =>
          !safeId.test(turn.turnId) ||
          (turn.startCommandId !== undefined && !safeId.test(turn.startCommandId)) ||
          (turn.runnerInstanceId !== undefined && !safeId.test(turn.runnerInstanceId)),
      )
    )
      throw new Error('Invalid runner ownership inventory');
    if (input.turns.length === 0) return [];
    const turnIds = input.turns.map((turn) => turn.turnId);
    const allowed = new Set(input.sessionIds);
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (tx) => {
        // Bound distinct identities, not frames: a long valid turn can have many frames.
        const frames = await tx
          .selectFrom('runner_frames')
          .select(['turn_id', 'session_id', 'runner_instance_id'])
          .where('turn_id', 'in', turnIds)
          .where('payload_hash', '!=', ABANDONED_TURN_FENCE_HASH)
          .distinct()
          .limit(1025)
          .execute();
        const running = await tx
          .selectFrom('running_turns')
          .select(['turn_id', 'session_id', 'start_command_id'])
          .where('turn_id', 'in', turnIds)
          .limit(1025)
          .execute();
        if (frames.length > 1024 || running.length > 1024)
          throw new Error('Runner ownership inventory limit');
        return input.turns.map((turn) => {
          const boundFrames = frames.filter((row) => row.turn_id === turn.turnId);
          const boundRunning = running.filter((row) => row.turn_id === turn.turnId);
          const owners = new Set([
            ...boundFrames.map((row) => row.session_id),
            ...boundRunning.map((row) => row.session_id),
          ]);
          const conflict =
            owners.size > 1 ||
            [...owners].some((owner) => !safeId.test(owner)) ||
            new Set(boundFrames.map((row) => row.runner_instance_id)).size > 1 ||
            boundFrames.some(
              (row) =>
                turn.runnerInstanceId !== undefined &&
                row.runner_instance_id !== turn.runnerInstanceId,
            ) ||
            boundRunning.some(
              (row) =>
                row.start_command_id === null ||
                !safeId.test(row.start_command_id) ||
                (turn.startCommandId !== undefined && row.start_command_id !== turn.startCommandId),
            );
          const owner = owners.size === 1 ? [...owners][0] : undefined;
          return {
            turnId: turn.turnId,
            ...(owner !== undefined && allowed.has(owner) && !conflict ? { sessionId: owner } : {}),
            conflict: conflict || (owner !== undefined && !allowed.has(owner)),
          };
        });
      });
  }

  /** All in-flight markers. At startup a non-empty result flags sessions whose
   * turn was abandoned by a crash/restart. */
  async listRunningTurns(): Promise<RunningTurnRecord[]> {
    const rows = await this.db
      .selectFrom('running_turns')
      .select([
        'session_id',
        'prompt_seq',
        'started_at',
        'turn_id',
        'start_command_id',
        'marker_id',
      ])
      .execute();
    return rows.map((row) => ({
      sessionId: row.session_id,
      promptSeq: Number(row.prompt_seq),
      startedAt: new Date(row.started_at),
      turnId: row.turn_id,
      startCommandId: row.start_command_id,
      markerId: row.marker_id,
    }));
  }
}
