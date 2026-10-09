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
  expectedParticipants?: number | null | undefined;
  speakerTurns?: Array<{ speaker: number; start: number; end: number }> | undefined;
  timedWords?: Array<{ text: string; start: number; end: number }> | undefined;
  speakerNames?: Record<string, string> | undefined;
  speakerCorrections?: Array<{ start: number; end: number; speaker: number | null }> | undefined;
  speakerMerges?: Record<string, number> | undefined;
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

export interface LiveMeetingInsight {
  id: string;
  meetingId: string;
  kind: 'contradiction' | 'research';
  summary: string;
  evidenceA: string;
  evidenceB: string | null;
  sourcePath: string | null;
  createdAt: number;
}

export class LiveMeetingStore {
  constructor(private readonly db: Kysely<Database>) {}

  async addInsight(
    sessionId: string,
    insight: LiveMeetingInsight,
    replace = false,
  ): Promise<boolean> {
    const meeting = await this.db
      .selectFrom('live_meetings')
      .select('session_id')
      .where('id', '=', insight.meetingId)
      .executeTakeFirst();
    if (meeting?.session_id !== sessionId) return false;
    await this.db
      .insertInto('live_meeting_insights')
      .values({
        id: insight.id,
        meeting_id: insight.meetingId,
        kind: insight.kind,
        summary: insight.summary,
        evidence_a: insight.evidenceA,
        evidence_b: insight.evidenceB,
        source_path: insight.sourcePath,
        created_at: insight.createdAt,
      })
      .onConflict((conflict) =>
        replace
          ? conflict
              .column('id')
              .doUpdateSet({ summary: insight.summary, evidence_a: insight.evidenceA })
              .where('live_meeting_insights.meeting_id', '=', insight.meetingId)
          : conflict.column('id').doNothing(),
      )
      .execute();
    return true;
  }

  /** Remove question suggestions invalidated by recognition corrections, under the meeting lock. */
  async reconcileQuestions(
    sessionId: string,
    meetingId: string,
    revision: number | undefined,
    classified?: {
      text: string;
      acceptedIds: readonly string[];
      resolvedIds: readonly string[];
      insights?: readonly LiveMeetingInsight[];
    },
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const meeting = await trx
        .selectFrom('live_meetings')
        .select(['transcript', 'revision'])
        .where('id', '=', meetingId)
        .where('session_id', '=', sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !meeting ||
        (revision !== undefined && Number(meeting.revision) !== revision) ||
        (classified !== undefined && revision === undefined)
      )
        return false;
      // Publish and retract under the same revision lock so corrections cannot expose stale evidence.
      for (const insight of classified?.insights ?? []) {
        if (
          insight.meetingId !== meetingId ||
          !insight.id.startsWith('question-') ||
          !meeting.transcript.includes(insight.evidenceA)
        )
          return false;
      }
      for (const insight of classified?.insights ?? []) {
        await trx
          .insertInto('live_meeting_insights')
          .values({
            id: insight.id,
            meeting_id: meetingId,
            kind: insight.kind,
            summary: insight.summary,
            evidence_a: insight.evidenceA,
            evidence_b: insight.evidenceB,
            source_path: insight.sourcePath,
            created_at: insight.createdAt,
          })
          .onConflict((conflict) =>
            conflict
              .column('id')
              .doUpdateSet({
                summary: insight.summary,
                evidence_a: insight.evidenceA,
              })
              .where('live_meeting_insights.meeting_id', '=', meetingId),
          )
          .execute();
      }
      const insights = await trx
        .selectFrom('live_meeting_insights')
        .select(['id', 'kind', 'evidence_a'])
        .where('meeting_id', '=', meetingId)
        .execute();
      const questions = insights.filter(({ id }) => id.startsWith('question-'));
      const removed = questions
        .filter(
          (question) =>
            !meeting.transcript.includes(question.evidence_a) ||
            (classified !== undefined &&
              classified.resolvedIds.includes(question.id) &&
              !classified.acceptedIds.includes(question.id)),
        )
        .map(({ id }) => id);
      const evidenceKey = (text: string) => text.trim().replace(/[.!?]+$/u, '');
      const acceptedEvidence = new Set(
        questions
          .filter(({ id }) => !removed.includes(id))
          .map((question) => evidenceKey(question.evidence_a)),
      );
      // A batch result can land before classification; once validated, the question owns that evidence.
      removed.push(
        ...insights
          .filter(
            (insight) =>
              insight.kind === 'research' &&
              !insight.id.startsWith('question-') &&
              acceptedEvidence.has(evidenceKey(insight.evidence_a)),
          )
          .map(({ id }) => id),
      );
      if (removed.length)
        await trx
          .deleteFrom('live_meeting_insights')
          .where('meeting_id', '=', meetingId)
          .where('id', 'in', removed)
          .execute();
      return true;
    });
  }

  async questions(sessionId: string, meetingId: string): Promise<LiveMeetingInsight[] | null> {
    return this.readInsights(sessionId, meetingId, true);
  }

  async insights(sessionId: string, meetingId: string): Promise<LiveMeetingInsight[] | null> {
    return this.readInsights(sessionId, meetingId, false);
  }

  private async readInsights(
    sessionId: string,
    meetingId: string,
    questionsOnly: boolean,
  ): Promise<LiveMeetingInsight[] | null> {
    const meeting = await this.db
      .selectFrom('live_meetings')
      .select('session_id')
      .where('id', '=', meetingId)
      .executeTakeFirst();
    if (meeting?.session_id !== sessionId) return null;
    const rows = await this.db
      .selectFrom('live_meeting_insights')
      .selectAll()
      .where('meeting_id', '=', meetingId)
      .$if(questionsOnly, (query) => query.where('id', 'like', 'question-%'))
      .orderBy('created_at', 'desc')
      .$if(!questionsOnly, (query) => query.limit(30))
      .execute();
    return rows.map((row) => ({
      id: row.id,
      meetingId: row.meeting_id,
      kind: row.kind,
      summary: row.summary,
      evidenceA: row.evidence_a,
      evidenceB: row.evidence_b,
      sourcePath: row.source_path,
      createdAt: Number(row.created_at),
    }));
  }

  async currentRevision(sessionId: string, meetingId: string): Promise<number | null> {
    const meeting = await this.db
      .selectFrom('live_meetings')
      .select('revision')
      .where('session_id', '=', sessionId)
      .where('id', '=', meetingId)
      .executeTakeFirst();
    return meeting ? Number(meeting.revision) : null;
  }

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
          expected_participants: meeting.expectedParticipants ?? null,
          speaker_turns_json: JSON.stringify(meeting.speakerTurns ?? []),
          timed_words_json: JSON.stringify(meeting.timedWords ?? []),
          speaker_names_json: JSON.stringify(meeting.speakerNames ?? {}),
          speaker_corrections_json: JSON.stringify(meeting.speakerCorrections ?? []),
          speaker_merges_json: JSON.stringify(meeting.speakerMerges ?? {}),
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
              expected_participants: meeting.expectedParticipants ?? null,
              speaker_turns_json: JSON.stringify(meeting.speakerTurns ?? []),
              timed_words_json: JSON.stringify(meeting.timedWords ?? []),
              speaker_names_json: JSON.stringify(meeting.speakerNames ?? {}),
              speaker_corrections_json: JSON.stringify(meeting.speakerCorrections ?? []),
              speaker_merges_json: JSON.stringify(meeting.speakerMerges ?? {}),
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
        expectedParticipants: row.expected_participants,
        speakerTurns: JSON.parse(row.speaker_turns_json) as Array<{
          speaker: number;
          start: number;
          end: number;
        }>,
        timedWords: JSON.parse(row.timed_words_json) as Array<{
          text: string;
          start: number;
          end: number;
        }>,
        speakerNames: JSON.parse(row.speaker_names_json) as Record<string, string>,
        speakerCorrections: JSON.parse(row.speaker_corrections_json) as Array<{
          start: number;
          end: number;
          speaker: number | null;
        }>,
        speakerMerges: JSON.parse(row.speaker_merges_json) as Record<string, number>,
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
