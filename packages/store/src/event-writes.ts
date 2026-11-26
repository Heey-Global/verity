import { sql, type Kysely } from 'kysely';
import { parseAgentEvent, type AgentEvent } from '@verity/events';
import type { Database } from './schema.js';
import { sessionEventAppendLock } from './session-event-lock.js';
import { findRecordedApprovalDecision } from './secret-approval-events.js';
import { scrubNulEscapes } from './nul-scrub.js';
import { redactSecrets } from './redact.js';

interface TurnAnchor {
  sessionId: string;
  promptSeq: number;
  turnId: string | null;
}
interface EventWriteDependencies {
  currentDb: () => Kysely<Database>;
  isSessionDeleting: (id: string) => Promise<boolean>;
  externalizeToolResult: (event: Extract<AgentEvent, { t: 'tool_result' }>) => Promise<AgentEvent>;
  enqueuePersistedMessageEvent: (id: string, seq: number, at: Date, event: AgentEvent) => void;
  scheduleMessageProjection: () => void;
}

/**
 * The only Runner frame protocol version the Server ingests (ADR 0006 D3). The
 * envelope the Runner stamps carries this so a Server that predates a future
 * protocol bump rejects an unknown frame rather than misreading it. Kept here in
 * `@verity/store` as the single source of truth — `@verity/session` (which depends
 * on this package) imports it to stamp outgoing frames, so writer and reader can
 * never drift.
 */
export const RUNNER_FRAME_PROTOCOL_VERSION = 1;

/**
 * The Server-side ingest descriptor for one Runner frame (ADR 0006 D4). It is the
 * transport-neutral projection of `@verity/session`'s `RunnerFrame` — carrying only
 * what the idempotent DB claim needs, so `@verity/store` never has to import the
 * session frame union (avoiding a package cycle). `event` normally contains the
 * transported event frame; a permission-request frame may instead carry the
 * server-authored `permission` event that makes the parked prompt durable and
 * replayable. Session/result frames omit it and persist no event row, but still
 * claim their `(turnId, frameSeq)` so the sequence stays contiguous. `payloadHash`
 * is treated as an opaque token: the Server stores it and compares it on replay
 * but never recomputes it, so the hashing algorithm lives solely Runner-side.
 */
export interface RunnerFrameIngest {
  protocolVersion: number;
  runnerInstanceId: string;
  turnId: string;
  frameSeq: number;
  payloadHash: string;
  /** The event to persist — present for event frames and surfaced permission requests. */
  event?: AgentEvent;
  /** Marks the final `result` frame. Its claim atomically closes the matching
   * running-turn marker and fences all later frames for this turn. */
  terminal?: true;
}

/** The outcome of {@link EventStore.ingestRunnerFrame}. `accepted` means the frame
 * was newly claimed (and any `event` newly persisted) — the caller should publish it
 * to live subscribers. `duplicate` means the frame was already ingested (a replay
 * after a crash) — it must NOT be re-published; a reconnecting client receives it via
 * backlog replay instead. `seq`/`ts` are the persisted event's identity, present for
 * event frames in both outcomes. They are consumed today only on the `accepted` path;
 * the `duplicate` seq/ts is carried for the reattach slice (which will re-derive a
 * frame's seq after a post-commit-pre-publish crash) and is not yet read by any
 * caller. */
export interface RunnerFrameIngestResult {
  outcome: 'accepted' | 'duplicate';
  seq?: number;
  ts?: number;
}

/**
 * The `payload_hash` that marks a `runner_frames` row as a FENCE rather than a frame
 * the Runner produced — see {@link EventStore.fenceAbandonedTurn}. A real hash is a
 * Runner-minted token, so this cannot collide with one; using the existing column
 * keeps the fence inside the table whose primary key already orders a turn's frames.
 */
export const ABANDONED_TURN_FENCE_HASH = 'verity:abandoned-turn-fence';

/** The `runner_instance_id` a fence carries when the turn never streamed a frame, so
 * there is no real instance to name. Excluded from the turn→instance binding check. */
const ABANDONED_TURN_FENCE_INSTANCE = 'verity:abandoned-turn-fence';
export class EventWriteStore {
  private readonly runnerFrameIngestTails = new Map<string, Promise<void>>();
  private readonly sessionEventAppendTails = new Map<string, Promise<void>>();
  constructor(private readonly deps: EventWriteDependencies) {}
  private get db(): Kysely<Database> {
    return this.deps.currentDb();
  }

  /**
   * Serialize every append to one session's event log.
   *
   * A conditional append ({@link appendEventForRunningTurn}) tests the log it is about
   * to write into. Under READ COMMITTED that test only sees what had COMMITTED when the
   * statement began, so a concurrent append — a Runner frame ingest in particular, whose
   * insert sits inside a multi-statement transaction — can be invisible to the predicate
   * and still take the lower id. The result would be a message about a turn that had
   * already spoken, placed after what it spoke.
   *
   * Serializing the appends removes the overlap instead of trying to detect it: each one
   * commits before the next begins, so the predicate reads a settled log. Server
   * generations overlap during reattach/cutover, so this in-process tail is only half of
   * it: every append also takes {@link sessionEventAppendLock} inside its transaction, so
   * the ordering holds between processes too. The tail is what makes that lock effective
   * under PGlite, which does not model advisory-lock contention between its concurrent
   * transactions — the same belt-and-braces pairing frame ingest and the message
   * projection already use.
   */
  async withSessionEventAppend<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const predecessor = this.sessionEventAppendTails.get(sessionId);
    let release!: () => void;
    const queued = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.sessionEventAppendTails.set(sessionId, queued);
    // Only an append that actually has a predecessor waits. An uncontended one issues
    // its statement in the caller's tick, as it did before there was a queue — the tail
    // is claimed synchronously above, so skipping the hop cannot reorder anything.
    if (predecessor !== undefined) await predecessor;
    try {
      return await run();
    } finally {
      release();
      if (this.sessionEventAppendTails.get(sessionId) === queued) {
        this.sessionEventAppendTails.delete(sessionId);
      }
    }
  }

  /** Serialize one turn's frame claims in-process (PGlite has no advisory locks). */
  async withRunnerFrameTurn<T>(turnId: string, run: () => Promise<T>): Promise<T> {
    const predecessor = this.runnerFrameIngestTails.get(turnId) ?? Promise.resolve();
    let release!: () => void;
    const queued = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.runnerFrameIngestTails.set(turnId, queued);
    await predecessor;
    try {
      return await run();
    } finally {
      release();
      if (this.runnerFrameIngestTails.get(turnId) === queued) {
        this.runnerFrameIngestTails.delete(turnId);
      }
    }
  }

  /**
   * Append one canonical event to the session's log. Validates against the
   * canonical schema first and refuses to persist anything invalid — the store
   * is the last line of defense behind the adapter's own guarantee. Returns the
   * assigned `seq` (bigserial id) and the row's `created_at` as epoch
   * milliseconds (`ts`), so the live fan-out can broadcast the real persist time
   * alongside `seq` (#32) — matching what the read paths surface.
   */
  async appendEvent(
    sessionId: string,
    event: AgentEvent,
  ): Promise<{ seq: number; ts: number; existing?: true }> {
    if (await this.deps.isSessionDeleting(sessionId)) throw new Error('Session is being deleted');
    const { type, payload } = await this.prepareEventRow(event);
    const row = await this.withSessionEventAppend(sessionId, () =>
      this.db.transaction().execute(async (tx) => {
        await sessionEventAppendLock(tx, sessionId);
        const existing = await findRecordedApprovalDecision(tx, sessionId, event);
        if (existing) return { ...existing, existing: true as const };
        const result = await sql<{ id: number; created_at: Date }>`
          insert into events (session_id, type, payload)
          select ${sessionId}, ${type}, ${payload}::jsonb
          where not exists (select 1 from session_deletions where session_id = ${sessionId})
          returning id, created_at
        `.execute(tx);
        const inserted = result.rows[0];
        if (inserted === undefined)
          throw new Error(`failed to append event to session ${sessionId}`);
        return inserted;
      }),
    );
    if ('existing' in row)
      return { seq: Number(row.id), ts: row.created_at.getTime(), existing: true };
    this.deps.enqueuePersistedMessageEvent(
      sessionId,
      Number(row.id),
      row.created_at,
      JSON.parse(payload) as AgentEvent,
    );
    return { seq: Number(row.id), ts: row.created_at.getTime() };
  }

  /**
   * {@link appendEvent}, but the row lands ONLY while `sessionId`'s in-flight marker
   * still anchors exactly the given turn (`prompt_seq` AND `turn_id`) and that turn has
   * stayed silent since `silentSinceSeq`. Returns `null` when it no longer does — the
   * turn spoke, settled, or was replaced — and then nothing was written.
   *
   * For an OUT-OF-BAND observer that reaches a verdict about one turn over seconds of
   * probing (the liveness sweep) and wants to say so in that turn's transcript. Checking
   * first would only narrow the race: the turn's own terminal event, the marker clear
   * that follows it, and the successor it drains can all land between the check and the
   * insert — putting a message about a dead turn after a successful result, or into a
   * healthy turn's transcript. `insert … select … where` is one statement, so what it
   * tests cannot be overtaken by what it writes, and {@link withSessionEventAppend}
   * keeps a concurrent append from being invisible to the test yet ordered before it.
   *
   * `turn_id` is part of the anchor, not just `prompt_seq`: a resume-retry re-anchors the
   * SAME `prompt_seq` as a fresh attempt with a new identity ({@link markTurnRunning}),
   * so `prompt_seq` alone would let a verdict about the previous attempt through.
   * `silentSinceSeq` is the newest event the observer saw before forming its verdict;
   * requiring the log not to have moved keeps this free of any notion of which events
   * end a turn — ANY new event means the observation is out of date.
   */
  async appendEventForRunningTurn(
    sessionId: string,
    anchor: { promptSeq: number; turnId: string | null; silentSinceSeq: number },
    event: AgentEvent,
  ): Promise<{ seq: number; ts: number } | null> {
    const { type, payload } = await this.prepareEventRow(event);
    const result = await this.withSessionEventAppend(sessionId, () =>
      this.db.transaction().execute(async (tx) => {
        await sessionEventAppendLock(tx, sessionId);
        return await sql<{ id: number; created_at: Date }>`
          insert into events (session_id, type, payload)
          select ${sessionId}, ${type}, ${payload}::jsonb
          from running_turns
          where session_id = ${sessionId}
            and not exists (select 1 from session_deletions where session_id = ${sessionId})
            and prompt_seq = ${anchor.promptSeq}
            and turn_id is not distinct from ${anchor.turnId}
            and not exists (
              select 1 from events
              where session_id = ${sessionId} and id > ${anchor.silentSinceSeq}
            )
          returning id, created_at
        `.execute(tx);
      }),
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    this.deps.enqueuePersistedMessageEvent(
      sessionId,
      Number(row.id),
      row.created_at,
      JSON.parse(payload) as AgentEvent,
    );
    return { seq: Number(row.id), ts: row.created_at.getTime() };
  }

  /** Validate, externalize, and redact an event into the exact `(type, payload)`
   * an `events` row stores. Shared by {@link appendEvent} and the Runner-frame
   * ingest path so both persist byte-identical rows. Runs the content-addressed
   * externalization (which writes to `attachments`) — that is idempotent and safe
   * to perform BEFORE the ingest transaction, so the transaction stays a tight
   * `events` + `runner_frames` claim. */
  async prepareEventRow(event: AgentEvent): Promise<{ type: string; payload: string }> {
    const parsed = parseAgentEvent(event);
    if (!parsed.success) {
      throw new Error(`refusing to persist invalid event: ${parsed.error.message}`);
    }
    // Externalize a tool result's heavy inline payloads into the content-addressed
    // blob table, so the PERSISTED event carries lazy refs (images #115, and large
    // text bodies) instead of the full bytes — a reload transfers only previews +
    // the visible images, not the whole backlog. The caller's `event` is left
    // untouched (only a copy is stored), so the live broadcast still ships the
    // inline bytes the client already has and can render without a round-trip.
    const canonical = parsed.data;
    const toStore =
      canonical.t === 'tool_result' ? await this.deps.externalizeToolResult(canonical) : canonical;
    // Redact recognized credentials from the PERSISTED copy (audit M9). Token
    // characters never include JSON structural chars, so redacting the serialized
    // payload keeps it valid JSON. The caller's live `event` is left untouched, so
    // the broadcast to the operator's own device is unaffected.
    // Scrub U+0000 from the PERSISTED copy last: PostgreSQL rejects a `jsonb`
    // document that carries one, which used to abort the whole turn on any agent
    // output echoing a NUL. Runs after redaction so both rewrites see the same
    // serialized string; the caller's live `event` again stays untouched.
    return { type: canonical.t, payload: scrubNulEscapes(redactSecrets(JSON.stringify(toStore))) };
  }

  /**
   * Ingest one Runner frame idempotently (ADR 0006 D4) — the restart-safe seam that
   * lets a new Server re-tail a turn's append-only frame file from byte zero without
   * duplicating events. In ONE transaction this:
   *
   *   1. verifies the immutable `turn_id → runner_instance_id` binding;
   *   2. returns `duplicate` if `(turn_id, frame_seq)` is already claimed — after
   *      checking the replay carries the SAME `payload_hash` (a changed one is
   *      corruption, not a duplicate);
   *   3. otherwise enforces contiguity (`frame_seq` 1, or `frame_seq - 1` present);
   *   4. persists the `event` row when the frame carries one; and
   *   5. claims `(turn_id, frame_seq)` under the primary key; and
   *   6. for a terminal frame, closes the matching `running_turns` marker.
   *
   * Only a newly-claimed frame returns `accepted` — the caller publishes those to
   * live subscribers and suppresses `duplicate`s (which reconnecting clients receive
   * through backlog replay). A single file tail delivers serially, while overlapping
   * Server generations are serialized by the per-turn in-process queue plus the
   * PostgreSQL transaction advisory lock below.
   *
   */
  async ingestRunnerFrame(
    sessionId: string,
    frame: RunnerFrameIngest,
  ): Promise<RunnerFrameIngestResult> {
    // Two kinds of frame decide what a conditional append sees: one that carries an
    // event appends to the session's log, and a TERMINAL one closes the marker that
    // append tests. Both do it from inside a multi-statement transaction, so either can
    // be invisible to a concurrent {@link appendEventForRunningTurn} — which would then
    // write "the Runner is gone" onto a turn that had just ended normally. Both join the
    // session's append order; a frame that only claims a mid-turn seq stays out of it.
    if (frame.event === undefined && frame.terminal !== true) {
      return await this.ingestRunnerFrameInner(sessionId, frame);
    }
    return await this.withSessionEventAppend(sessionId, () =>
      this.ingestRunnerFrameInner(sessionId, frame),
    );
  }

  async ingestRunnerFrameInner(
    sessionId: string,
    frame: RunnerFrameIngest,
  ): Promise<RunnerFrameIngestResult> {
    if (await this.deps.isSessionDeleting(sessionId)) throw new Error('Session is being deleted');
    if (frame.protocolVersion !== RUNNER_FRAME_PROTOCOL_VERSION) {
      throw new Error(
        `unsupported runner frame protocol version ${frame.protocolVersion} ` +
          `(this server ingests version ${RUNNER_FRAME_PROTOCOL_VERSION})`,
      );
    }
    if (!Number.isInteger(frame.frameSeq) || frame.frameSeq < 1) {
      throw new Error(`runner frame seq must be a positive integer, got ${frame.frameSeq}`);
    }
    if (frame.terminal === true && frame.event !== undefined) {
      throw new Error('runner terminal frame cannot also carry an event');
    }
    // The fence below is recognized by its reserved `payload_hash`, and nothing
    // constrains what a Runner puts in that column — so refuse the sentinel here
    // rather than trust that no frame carries it. This is what makes "a row with
    // this hash is a fence" true instead of merely likely: a frame claiming it is
    // rejected before it can be stored, so no turn can be fenced by its own stream.
    if (frame.payloadHash === ABANDONED_TURN_FENCE_HASH) {
      throw new Error(
        `runner frame refused: payload hash ${ABANDONED_TURN_FENCE_HASH} is reserved ` +
          'for recovery fences',
      );
    }
    // Prepare the event row (validate + externalize + redact) BEFORE the transaction:
    // externalization writes content-addressed `attachments` rows that are idempotent
    // and harmless if the transaction later rolls back, keeping the claim atomic and small.
    const eventRow =
      frame.event !== undefined ? await this.prepareEventRow(frame.event) : undefined;

    const predecessor = this.runnerFrameIngestTails.get(frame.turnId) ?? Promise.resolve();
    let release!: () => void;
    const queued = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.runnerFrameIngestTails.set(frame.turnId, queued);
    await predecessor;
    try {
      return await this.db.transaction().execute(async (tx) => {
        // Multiple Server generations may overlap during reattach/cutover. Serialize
        // claims for one turn across processes, not merely within one file tail, so
        // terminal fencing cannot race a later frame. The lock is transaction-scoped.
        // An ingest that appends an event or closes the marker takes the session's
        // append lock first, in that order everywhere, so it cannot be invisible to a
        // conditional append yet ordered ahead of it — and the two locks cannot be
        // taken in opposite orders.
        if (eventRow !== undefined || frame.terminal === true) {
          await sessionEventAppendLock(tx, sessionId);
        }
        await sql`select pg_advisory_xact_lock(hashtext(${frame.turnId}))`.execute(tx);
        if (
          await tx
            .selectFrom('session_deletions')
            .select('session_id')
            .where('session_id', '=', sessionId)
            .executeTakeFirst()
        )
          throw new Error('Session is being deleted');

        // (0) the turn was abandoned by recovery — refuse everything from the fence on.
        // Contiguity puts every already-claimed frame below it, so a replay of what the
        // turn said while it still held the session stays a valid duplicate below.
        const fence = await tx
          .selectFrom('runner_frames')
          .select('frame_seq')
          .where('turn_id', '=', frame.turnId)
          .where('payload_hash', '=', ABANDONED_TURN_FENCE_HASH)
          .executeTakeFirst();
        if (fence !== undefined && frame.frameSeq >= Number(fence.frame_seq)) {
          throw new Error(
            `runner frame refused: turn ${frame.turnId} was abandoned by recovery at seq ` +
              `${fence.frame_seq}, refusing seq ${frame.frameSeq}`,
          );
        }

        // (1) immutable turn → runner-instance binding. Fence rows are excluded: the
        // fence may have been planted before the turn ever streamed a frame, and its
        // placeholder instance id is not the turn's binding.
        const bound = await tx
          .selectFrom('runner_frames')
          .select(['runner_instance_id', 'session_id'])
          .where('turn_id', '=', frame.turnId)
          .where('payload_hash', '!=', ABANDONED_TURN_FENCE_HASH)
          .limit(1)
          .executeTakeFirst();
        if (bound !== undefined && bound.runner_instance_id !== frame.runnerInstanceId) {
          throw new Error(
            `runner frame corruption: turn ${frame.turnId} is bound to runner instance ` +
              `${bound.runner_instance_id}, refusing a frame from ${frame.runnerInstanceId}`,
          );
        }
        if (bound !== undefined && bound.session_id !== sessionId) {
          throw new Error(
            `runner frame corruption: turn ${frame.turnId} is bound to session ` +
              `${bound.session_id}, refusing a frame for ${sessionId}`,
          );
        }

        // (2) already claimed → duplicate (a replay). Guard the payload hash.
        const existing = await tx
          .selectFrom('runner_frames')
          .select(['payload_hash', 'event_id', 'terminal'])
          .where('turn_id', '=', frame.turnId)
          .where('frame_seq', '=', frame.frameSeq)
          .executeTakeFirst();
        if (existing !== undefined) {
          if (existing.payload_hash !== frame.payloadHash) {
            throw new Error(
              `runner frame corruption: (turn ${frame.turnId}, seq ${frame.frameSeq}) was ` +
                `replayed with a changed payload`,
            );
          }
          // Rolling-deploy compatibility: pre-0053/older Servers wrote result claims
          // without the terminal bit. A hash-identical replay from a new Server carries
          // the missing kind information, so promote that claim and close its marker in
          // this transaction. This is idempotent and scoped away from newer turns.
          if (frame.terminal === true && !existing.terminal) {
            const later = await tx
              .selectFrom('runner_frames')
              .select('frame_seq')
              .where('turn_id', '=', frame.turnId)
              .where('frame_seq', '>', frame.frameSeq)
              .executeTakeFirst();
            if (later !== undefined) {
              throw new Error(
                `runner frame corruption: cannot promote terminal seq ${frame.frameSeq} for turn ` +
                  `${frame.turnId}; later seq ${later.frame_seq} already exists`,
              );
            }
            await tx
              .updateTable('runner_frames')
              .set({ terminal: true })
              .where('turn_id', '=', frame.turnId)
              .where('frame_seq', '=', frame.frameSeq)
              .execute();
            await tx
              .deleteFrom('running_turns')
              .where('session_id', '=', sessionId)
              .where('turn_id', '=', frame.turnId)
              .execute();
          }
          if (existing.event_id !== null) {
            const ev = await tx
              .selectFrom('events')
              .select('created_at')
              .where('id', '=', existing.event_id)
              .executeTakeFirst();
            if (ev !== undefined) {
              return {
                outcome: 'duplicate',
                seq: Number(existing.event_id),
                ts: ev.created_at.getTime(),
              };
            }
          }
          return { outcome: 'duplicate' };
        }

        // A result is the final frame (D3). Once its claim commits, a second result
        // or any other later frame is corruption rather than another harmless replay.
        // Same-sequence replays returned above remain valid duplicates.
        const terminal = await tx
          .selectFrom('runner_frames')
          .select('frame_seq')
          .where('turn_id', '=', frame.turnId)
          .where('terminal', '=', true)
          .executeTakeFirst();
        if (terminal !== undefined) {
          throw new Error(
            `runner frame corruption: turn ${frame.turnId} already terminated at seq ` +
              `${terminal.frame_seq}, refusing seq ${frame.frameSeq}`,
          );
        }

        // (3) contiguity: seq 1 is the anchor; otherwise the predecessor must exist.
        if (frame.frameSeq > 1) {
          const prev = await tx
            .selectFrom('runner_frames')
            .select('frame_seq')
            .where('turn_id', '=', frame.turnId)
            .where('frame_seq', '=', frame.frameSeq - 1)
            .executeTakeFirst();
          if (prev === undefined) {
            throw new Error(
              `runner frame gap: turn ${frame.turnId} received seq ${frame.frameSeq} ` +
                `before seq ${frame.frameSeq - 1}`,
            );
          }
        }

        // (4) persist the event, if any — atomically with the claim below.
        let eventId: number | null = null;
        let result: RunnerFrameIngestResult = { outcome: 'accepted' };
        if (eventRow !== undefined) {
          const row = await tx
            .insertInto('events')
            .values({ session_id: sessionId, type: eventRow.type, payload: eventRow.payload })
            .returning(['id', 'created_at'])
            .executeTakeFirstOrThrow();
          eventId = Number(row.id);
          result = { outcome: 'accepted', seq: eventId, ts: row.created_at.getTime() };
        }

        // (5) claim (turn_id, frame_seq) under the primary key.
        await tx
          .insertInto('runner_frames')
          .values({
            turn_id: frame.turnId,
            frame_seq: frame.frameSeq,
            runner_instance_id: frame.runnerInstanceId,
            session_id: sessionId,
            payload_hash: frame.payloadHash,
            event_id: eventId,
            terminal: frame.terminal === true,
          })
          .execute();

        // Scope by BOTH session and turn identity: a late terminal from an older turn
        // must never delete a newer marker for the same session. This delete commits
        // atomically with the terminal claim, eliminating the append/commit crash gap.
        if (frame.terminal === true) {
          await tx
            .deleteFrom('running_turns')
            .where('session_id', '=', sessionId)
            .where('turn_id', '=', frame.turnId)
            .execute();
        }

        return result;
      });
    } finally {
      if (eventRow !== undefined) this.deps.scheduleMessageProjection();
      release();
      if (this.runnerFrameIngestTails.get(frame.turnId) === queued) {
        this.runnerFrameIngestTails.delete(frame.turnId);
      }
    }
  }

  /**
   * Close a turn's frame stream for good, for a Runner that was never confirmed gone.
   *
   * ADR 0006 D7 step 5 gives up on a Runner the discovery seam can never answer for and
   * settles its turn so the session is usable again. That verdict is a bound, not proof:
   * the Runner may still be alive and may still stream. A confirmed-dead one is fenced
   * by its own terminal frame; this one has none, so nothing would stop its frames from
   * appending into the transcript of whatever turn holds the session next.
   *
   * The fence is a `runner_frames` row claiming the next sequence with a reserved
   * `payload_hash`, so it lives under the primary key that already orders a turn's
   * frames and needs no state of its own. Everything from that sequence on is refused;
   * a replay of a frame the turn claimed while it still held the session sits below the
   * fence and stays a valid duplicate. Idempotent — fencing an already-fenced turn is a
   * no-op, so the retry that follows a failed settle does not stack fences.
   *
   * What this cannot do is stop the Runner itself. A Runner that cannot be reached
   * cannot be killed, so its side effects on the worktree are the residual cost of
   * bounding step 5 — the fence bounds what reaches the LOG, not what reaches the disk.
   */
  /** An abandoned stream fence closes the log, but never proves worker exit. */
  async hasAbandonedRunnerTurns(sessionId: string): Promise<boolean> {
    return (
      (await this.db
        .selectFrom('runner_frames')
        .select('turn_id')
        .where('session_id', '=', sessionId)
        .where('payload_hash', '=', ABANDONED_TURN_FENCE_HASH)
        .executeTakeFirst()) !== undefined
    );
  }

  async fenceAbandonedTurn(sessionId: string, turnId: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${turnId}))`.execute(tx);
      const rows = await tx
        .selectFrom('runner_frames')
        .select(['frame_seq', 'runner_instance_id', 'payload_hash'])
        .where('turn_id', '=', turnId)
        .orderBy('frame_seq', 'desc')
        .execute();
      if (rows.some((row) => row.payload_hash === ABANDONED_TURN_FENCE_HASH)) return;
      const last = rows[0];
      await tx
        .insertInto('runner_frames')
        .values({
          turn_id: turnId,
          frame_seq: last === undefined ? 1 : Number(last.frame_seq) + 1,
          // Carry the turn's real binding when it has one, so the instance check keeps
          // reading the same value whether or not the fence row is present.
          runner_instance_id: last?.runner_instance_id ?? ABANDONED_TURN_FENCE_INSTANCE,
          session_id: sessionId,
          payload_hash: ABANDONED_TURN_FENCE_HASH,
          event_id: null,
          terminal: true,
        })
        .execute();
    });
  }

  /**
   * Fence a still-running turn only if it has remained silent through `latestSeq`.
   *
   * The turn advisory lock is the same lock used by runner-frame ingestion, making
   * the silence check and fence insertion atomic with respect to a late frame. A
   * changed marker or any newer event refuses the fence and leaves the turn alone.
   */
  async fenceRunningTurnIfSilent(
    anchor: TurnAnchor,
    latestSeq: number,
    event?: AgentEvent,
  ): Promise<{ seq: number; ts: number; fenceSeq: number; noticeSeq: number | null } | null> {
    if (anchor.turnId === null) return null;
    const turnId = anchor.turnId;
    const eventRow = event === undefined ? undefined : await this.prepareEventRow(event);
    const result = await this.withSessionEventAppend(anchor.sessionId, () =>
      this.withRunnerFrameTurn(turnId, () =>
        this.db.transaction().execute(async (tx) => {
          // Keep the global order used by event-bearing frame ingestion: session
          // append lock first, then turn lock. The former makes the MAX(events.id)
          // predicate atomic with every canonical event writer; the latter makes
          // the fence atomic with every frame claim.
          await sessionEventAppendLock(tx, anchor.sessionId);
          await sql`select pg_advisory_xact_lock(hashtext(${turnId}))`.execute(tx);
          const marker = await tx
            .selectFrom('running_turns')
            .select(['prompt_seq', 'turn_id'])
            .where('session_id', '=', anchor.sessionId)
            .executeTakeFirst();
          if (
            marker === undefined ||
            Number(marker.prompt_seq) !== anchor.promptSeq ||
            marker.turn_id !== turnId
          ) {
            return null;
          }
          const newest = await tx
            .selectFrom('events')
            .select((eb) => eb.fn.max('id').as('seq'))
            .where('session_id', '=', anchor.sessionId)
            .executeTakeFirst();
          if (Number(newest?.seq ?? 0) !== latestSeq) return null;

          const rows = await tx
            .selectFrom('runner_frames')
            .select(['frame_seq', 'runner_instance_id', 'payload_hash'])
            .where('turn_id', '=', turnId)
            .orderBy('frame_seq', 'desc')
            .execute();
          if (rows.some((row) => row.payload_hash === ABANDONED_TURN_FENCE_HASH)) return null;

          let persisted: { seq: number; ts: number } = { seq: latestSeq, ts: Date.now() };
          if (eventRow !== undefined) {
            const inserted = await tx
              .insertInto('events')
              .values({
                session_id: anchor.sessionId,
                type: eventRow.type,
                payload: eventRow.payload,
              })
              .returning(['id', 'created_at'])
              .executeTakeFirstOrThrow();
            persisted = { seq: Number(inserted.id), ts: inserted.created_at.getTime() };
          }

          const last = rows[0];
          await tx
            .insertInto('runner_frames')
            .values({
              turn_id: turnId,
              frame_seq: last === undefined ? 1 : Number(last.frame_seq) + 1,
              runner_instance_id: last?.runner_instance_id ?? ABANDONED_TURN_FENCE_INSTANCE,
              session_id: anchor.sessionId,
              payload_hash: ABANDONED_TURN_FENCE_HASH,
              event_id: null,
              terminal: true,
            })
            .execute();
          return {
            ...persisted,
            fenceSeq: last === undefined ? 1 : Number(last.frame_seq) + 1,
            noticeSeq: eventRow === undefined ? null : persisted.seq,
          };
        }),
      ),
    );
    return result;
  }

  /** Undo a stalled-turn fence when shutdown won immediately after it committed. */
  async releaseRunningTurnFence(
    anchor: TurnAnchor,
    noticeSeq: number | null,
    fenceSeq: number,
  ): Promise<void> {
    if (anchor.turnId === null) return;
    const turnId = anchor.turnId;
    let projectionInvalidated = false;
    await this.withSessionEventAppend(anchor.sessionId, () =>
      this.withRunnerFrameTurn(turnId, () =>
        this.db.transaction().execute(async (tx) => {
          await sessionEventAppendLock(tx, anchor.sessionId);
          await sql`select pg_advisory_xact_lock(hashtext(${turnId}))`.execute(tx);
          const removed = await tx
            .deleteFrom('runner_frames')
            .where('turn_id', '=', turnId)
            .where('frame_seq', '=', fenceSeq)
            .where('payload_hash', '=', ABANDONED_TURN_FENCE_HASH)
            .executeTakeFirst();
          if (removed.numDeletedRows === 0n) return;
          if (noticeSeq !== null) {
            const deleted = await tx
              .deleteFrom('events')
              .where('session_id', '=', anchor.sessionId)
              .where('id', '=', noticeSeq)
              .executeTakeFirst();
            if (deleted.numDeletedRows > 0n) {
              // The search view may already contain this provisional notice and its
              // cursor may point beyond the now-removed event. Reset it in the same
              // transaction, then rebuild from the surviving canonical log after
              // commit. Serialize with both live projection and backfill before
              // resetting: either may already have read the notice and would
              // otherwise reinsert it after this transaction commits. A rollback
              // therefore restores both canonical and projected state together.
              await sql`select pg_advisory_xact_lock(hashtext(${
                'messages:' + anchor.sessionId
              }))`.execute(tx);
              await tx.deleteFrom('messages').where('session_id', '=', anchor.sessionId).execute();
              await tx
                .deleteFrom('message_projection_state')
                .where('session_id', '=', anchor.sessionId)
                .execute();
              projectionInvalidated = true;
            }
          }
        }),
      ),
    );
    if (projectionInvalidated) this.deps.scheduleMessageProjection();
  }

  /**
   * Atomically drain a queued turn (lifecycle Phase 1, SR-5): in ONE transaction,
   * delete its durable `queued_turns` row AND append its prompt `event`. Either the
   * turn leaves the queue and its prompt is persisted, or neither — closing the
   * `delete → persist` window where a crash dropped the row (double-run on restart)
   * or dropped the prompt (lost turn). Returns the appended event's `seq`/`ts` for
   * the live broadcast, or `undefined` if the row was already gone (a concurrent
   * drain/retract won the race — the run-once latch: nothing persisted, no turn).
   *
   * The event is the drained turn's prompt (never a `tool_result`), so it needs no
   * blob externalization — its attachments are already content-addressed refs.
   */
  async drainQueuedTurn(
    id: string,
    sessionId: string,
    event: AgentEvent,
  ): Promise<{ seq: number; ts: number } | undefined> {
    const parsed = parseAgentEvent(event);
    if (!parsed.success) {
      throw new Error(`refusing to persist invalid event: ${parsed.error.message}`);
    }
    const payload = scrubNulEscapes(redactSecrets(JSON.stringify(event)));
    const persisted = await this.withSessionEventAppend(sessionId, () =>
      this.db.transaction().execute(async (tx) => {
        await sessionEventAppendLock(tx, sessionId);
        const del = await tx.deleteFrom('queued_turns').where('id', '=', id).executeTakeFirst();
        if (del.numDeletedRows === 0n) return undefined;
        const row = await tx
          .insertInto('events')
          .values({
            session_id: sessionId,
            type: event.t,
            payload,
          })
          .returning(['id', 'created_at'])
          .executeTakeFirstOrThrow();
        return { seq: Number(row.id), ts: row.created_at.getTime() };
      }),
    );
    // Enqueue only AFTER the transaction commits. Doing this inside the callback
    // could project a prompt from a transaction that subsequently rolled back;
    // omitting it entirely left successfully drained prompts absent from search
    // until an unrelated backfill happened to run.
    if (persisted !== undefined) {
      this.deps.enqueuePersistedMessageEvent(
        sessionId,
        persisted.seq,
        new Date(persisted.ts),
        JSON.parse(payload) as AgentEvent,
      );
    }
    return persisted;
  }
}
