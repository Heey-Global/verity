import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';

export interface LiveMeetingSyncRecord {
  id: string;
  sessionId: string;
  engine: string;
  startedAt: number;
  endedAt: number | null;
  state: 'active' | 'interrupted' | 'ended';
  transcript: string;
  captureStatus: string;
  ownerTokenHash: string;
  revision: number;
}

export interface LiveMeetingNoteSyncRecord {
  id: string;
  meetingId: string;
  atSeconds: number;
  text: string;
  revision: number;
}

export interface LiveMeetingCommand {
  id: string;
  meetingId: string;
  action: 'pause' | 'resume' | 'stop';
  state: 'pending' | 'completed' | 'failed';
  error: string | null;
  requestedAt: number;
  acknowledgedAt: number | null;
}

export class LiveMeetingStore {
  constructor(private readonly db: Kysely<Database>) {}

  private async nextUpdateSequence(db: Kysely<Database>): Promise<number> {
    // The single clock row is locked until commit. A poll can never advance past
    // a lower sequence that is still uncommitted in another transaction.
    const row = await db
      .updateTable('live_meeting_sync_clock')
      .set({ sequence: sql`sequence + 1` })
      .where('id', '=', true)
      .returning('sequence')
      .executeTakeFirstOrThrow();
    return Number(row.sequence);
  }

  async putMeeting(meeting: LiveMeetingSyncRecord): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const sequence = await this.nextUpdateSequence(trx);
      await trx
        .insertInto('live_meetings')
        .values({
          id: meeting.id,
          session_id: meeting.sessionId,
          engine: meeting.engine,
          started_at: meeting.startedAt,
          ended_at: meeting.endedAt,
          state: meeting.state,
          transcript: meeting.transcript,
          capture_status: meeting.captureStatus,
          owner_token_hash: meeting.ownerTokenHash,
          recorder_last_seen_at: Date.now(),
          revision: meeting.revision,
          updated_seq: sequence,
        })
        .onConflict((conflict) =>
          conflict
            .column('id')
            .doUpdateSet({
              ended_at: meeting.endedAt,
              state: meeting.state,
              transcript: meeting.transcript,
              capture_status: meeting.captureStatus,
              recorder_last_seen_at: Date.now(),
              revision: meeting.revision,
              updated_seq: sequence,
            })
            .where('live_meetings.session_id', '=', meeting.sessionId)
            .where('live_meetings.owner_token_hash', '=', meeting.ownerTokenHash)
            .where('live_meetings.revision', '<', meeting.revision),
        )
        .execute();
      const existing = await trx
        .selectFrom('live_meetings')
        .select(['session_id', 'owner_token_hash', 'revision', 'state'])
        .where('id', '=', meeting.id)
        .executeTakeFirst();
      const accepted =
        existing?.session_id === meeting.sessionId &&
        existing.owner_token_hash === meeting.ownerTokenHash;
      if (
        accepted &&
        Number(existing.revision) === meeting.revision &&
        existing.state !== 'active'
      ) {
        await trx
          .updateTable('live_meeting_commands')
          .set({
            state:
              existing.state === 'ended'
                ? sql`case when action = 'stop' then 'completed' else 'failed' end`
                : 'failed',
            error:
              existing.state === 'ended'
                ? sql`case when action = 'stop' then null else 'Recording ended.' end`
                : 'Recording interrupted.',
            acknowledged_at: Date.now(),
          })
          .where('meeting_id', '=', meeting.id)
          .where('state', '=', 'pending')
          .execute();
      }
      return accepted;
    });
  }

  async commands(sessionId: string, meetingId: string): Promise<LiveMeetingCommand[] | null> {
    const meeting = await this.db
      .selectFrom('live_meetings')
      .select('id')
      .where('id', '=', meetingId)
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    if (!meeting) return null;
    const rows = await this.db
      .selectFrom('live_meeting_commands')
      .selectAll()
      .where('meeting_id', '=', meetingId)
      .orderBy('command_order', 'desc')
      .limit(10)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      meetingId: row.meeting_id,
      action: row.action,
      state: row.state,
      error: row.error,
      requestedAt: Number(row.requested_at),
      acknowledgedAt: row.acknowledged_at == null ? null : Number(row.acknowledged_at),
    }));
  }

  async requestCommand(
    sessionId: string,
    meetingId: string,
    id: string,
    action: LiveMeetingCommand['action'],
  ): Promise<'accepted' | 'missing' | 'pending'> {
    return this.db.transaction().execute(async (trx) => {
      // Shares the clock row lock with final meeting uploads. A command is
      // either inserted before finalization (and resolved there), or sees ended.
      await trx
        .selectFrom('live_meeting_sync_clock')
        .select('id')
        .where('id', '=', true)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const meeting = await trx
        .selectFrom('live_meetings')
        .select('state')
        .where('id', '=', meetingId)
        .where('session_id', '=', sessionId)
        .executeTakeFirst();
      if (!meeting || meeting.state !== 'active') return 'missing';
      if (action === 'stop') {
        await trx
          .updateTable('live_meeting_commands')
          .set({
            state: 'failed',
            error: 'Superseded by stop.',
            acknowledged_at: Date.now(),
          })
          .where('meeting_id', '=', meetingId)
          .where('state', '=', 'pending')
          .where('action', '!=', 'stop')
          .execute();
      }
      const inserted = await trx
        .insertInto('live_meeting_commands')
        .values({
          id,
          meeting_id: meetingId,
          action,
          state: 'pending',
          error: null,
          requested_at: Date.now(),
          acknowledged_at: null,
        })
        .onConflict((conflict) => conflict.doNothing())
        .returning('id')
        .executeTakeFirst();
      return inserted ? 'accepted' : 'pending';
    });
  }

  async recorderOnline(sessionId: string, meetingId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('live_meetings')
      .select(['recorder_last_seen_at', 'state'])
      .where('id', '=', meetingId)
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    return row?.state === 'active' && Date.now() - Number(row.recorder_last_seen_at) < 10_000;
  }

  async acknowledgeCommand(
    sessionId: string,
    meetingId: string,
    id: string,
    ownerTokenHash: string,
    state: 'completed' | 'failed',
    error: string | null,
  ): Promise<boolean> {
    const updated = await this.db
      .updateTable('live_meeting_commands')
      .set({
        state,
        error,
        acknowledged_at: Date.now(),
      })
      .where('id', '=', id)
      .where('meeting_id', '=', meetingId)
      .where('state', '=', 'pending')
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('live_meetings')
            .select('id')
            .where('id', '=', meetingId)
            .where('session_id', '=', sessionId)
            .where('owner_token_hash', '=', ownerTokenHash),
        ),
      )
      .returning('id')
      .executeTakeFirst();
    return !!updated;
  }

  async ownerCommands(
    sessionId: string,
    meetingId: string,
    ownerTokenHash: string,
  ): Promise<LiveMeetingCommand[] | null> {
    const owner = await this.db
      .selectFrom('live_meetings')
      .select('id')
      .where('id', '=', meetingId)
      .where('session_id', '=', sessionId)
      .where('owner_token_hash', '=', ownerTokenHash)
      .executeTakeFirst();
    if (!owner) return null;
    await this.db
      .updateTable('live_meetings')
      .set({ recorder_last_seen_at: Date.now() })
      .where('id', '=', meetingId)
      .where('session_id', '=', sessionId)
      .where('owner_token_hash', '=', ownerTokenHash)
      .execute();
    return (
      (await this.commands(sessionId, meetingId))?.filter(
        (command) => command.state === 'pending',
      ) ?? []
    );
  }

  async putNote(sessionId: string, note: LiveMeetingNoteSyncRecord): Promise<boolean> {
    const meeting = await this.db
      .selectFrom('live_meetings')
      .select('session_id')
      .where('id', '=', note.meetingId)
      .executeTakeFirst();
    if (meeting?.session_id !== sessionId) return false;
    return this.db.transaction().execute(async (trx) => {
      const sequence = await this.nextUpdateSequence(trx);
      await trx
        .insertInto('live_meeting_notes')
        .values({
          id: note.id,
          meeting_id: note.meetingId,
          at_seconds: note.atSeconds,
          text: note.text,
          revision: note.revision,
          updated_seq: sequence,
        })
        .onConflict((conflict) =>
          conflict
            .column('id')
            .doUpdateSet({
              at_seconds: note.atSeconds,
              text: note.text,
              revision: note.revision,
              updated_seq: sequence,
            })
            .where('live_meeting_notes.meeting_id', '=', note.meetingId)
            .where('live_meeting_notes.revision', '<', note.revision),
        )
        .execute();
      const existing = await trx
        .selectFrom('live_meeting_notes')
        .select('meeting_id')
        .where('id', '=', note.id)
        .executeTakeFirst();
      return existing?.meeting_id === note.meetingId;
    });
  }

  async changes(
    sessionId: string,
    after: number,
  ): Promise<{
    cursor: number;
    meetings: Omit<LiveMeetingSyncRecord, 'ownerTokenHash'>[];
    notes: LiveMeetingNoteSyncRecord[];
  }> {
    const snapshot = await sql<{ cursor: number | string }>`select greatest(
      coalesce((select max(updated_seq) from live_meetings where session_id = ${sessionId}), 0),
      coalesce((select max(n.updated_seq) from live_meeting_notes n
        join live_meetings m on m.id = n.meeting_id where m.session_id = ${sessionId}), 0)
    ) as cursor`.execute(this.db);
    const cursor = Number(snapshot.rows[0]?.cursor ?? 0);
    const [meetings, notes] = await Promise.all([
      this.db
        .selectFrom('live_meetings')
        .selectAll()
        .where('session_id', '=', sessionId)
        .where('updated_seq', '>', after)
        .where('updated_seq', '<=', cursor)
        .orderBy('updated_seq')
        .execute(),
      this.db
        .selectFrom('live_meeting_notes as n')
        .innerJoin('live_meetings as m', 'm.id', 'n.meeting_id')
        .select(['n.id', 'n.meeting_id', 'n.at_seconds', 'n.text', 'n.revision'])
        .where('m.session_id', '=', sessionId)
        .where('n.updated_seq', '>', after)
        .where('n.updated_seq', '<=', cursor)
        .orderBy('n.updated_seq')
        .execute(),
    ]);
    return {
      cursor,
      meetings: meetings.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        engine: row.engine,
        startedAt: Number(row.started_at),
        endedAt: row.ended_at == null ? null : Number(row.ended_at),
        state: row.state,
        transcript: row.transcript,
        captureStatus: row.capture_status,
        revision: Number(row.revision),
      })),
      notes: notes.map((row) => ({
        id: row.id,
        meetingId: row.meeting_id,
        atSeconds: Number(row.at_seconds),
        text: row.text,
        revision: Number(row.revision),
      })),
    };
  }
}
