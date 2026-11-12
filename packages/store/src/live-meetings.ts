import { TaskStore } from './tasks.js';
import { createPassthroughCipher, type SecretCipher } from './crypto.js';
import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';

export interface LiveMeetingSyncRecord {
  title?: string | null | undefined;
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

export interface LiveMeetingResultItem {
  id: string;
  text: string;
  quote: string;
  speaker: number | null;
  atSeconds: number | null;
}

export interface LiveMeetingResultTask extends LiveMeetingResultItem {
  state: 'proposed' | 'added' | 'dismissed';
  taskId: string | null;
}

export interface LiveMeetingResult {
  meetingId: string;
  revision: number;
  status: 'working' | 'ready' | 'failed';
  title: string | null;
  summary: string | null;
  decisions: LiveMeetingResultItem[];
  tasks: LiveMeetingResultTask[];
  openQuestions: LiveMeetingResultItem[];
  model: string | null;
  createdAt: number;
  updatedAt: number;
}

export class LiveMeetingStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly cipher: SecretCipher = createPassthroughCipher(),
  ) {}

  async unfinishedResults(): Promise<Array<{ sessionId: string; meetingId: string }>> {
    const rows = await this.db
      .selectFrom('live_meeting_results as result')
      .innerJoin('live_meetings as meeting', 'meeting.id', 'result.meeting_id')
      .select(['meeting.session_id', 'meeting.id'])
      .where((eb) =>
        eb.or([
          eb('result.status', '=', 'working'),
          eb.and([eb('result.status', '=', 'ready'), eb('result.filed_revision', 'is', null)]),
        ]),
      )
      .where('meeting.state', '!=', 'active')
      .execute();
    return rows.map((row) => ({ sessionId: row.session_id, meetingId: row.id }));
  }

  async resultFiled(sessionId: string, meetingId: string, revision: number): Promise<boolean> {
    const row = await this.db
      .selectFrom('live_meeting_results as result')
      .innerJoin('live_meetings as meeting', 'meeting.id', 'result.meeting_id')
      .select('result.filed_revision')
      .where('meeting.session_id', '=', sessionId)
      .where('meeting.id', '=', meetingId)
      .executeTakeFirst();
    return row?.filed_revision != null && Number(row.filed_revision) === revision;
  }

  async markResultFiled(sessionId: string, meetingId: string, revision: number): Promise<void> {
    await this.db
      .updateTable('live_meeting_results')
      .set({ filed_revision: revision })
      .where('meeting_id', '=', meetingId)
      .where('revision', '=', revision)
      .where('status', '=', 'ready')
      .where(
        'meeting_id',
        'in',
        this.db
          .selectFrom('live_meetings')
          .select('id')
          .where('session_id', '=', sessionId)
          .where('revision', '=', revision),
      )
      .execute();
  }

  async result(
    sessionId: string,
    meetingId: string,
    includeStale = false,
  ): Promise<LiveMeetingResult | null> {
    const row = await this.db
      .selectFrom('live_meeting_results as result')
      .innerJoin('live_meetings as meeting', 'meeting.id', 'result.meeting_id')
      .selectAll('result')
      .where('meeting.session_id', '=', sessionId)
      .where('meeting.id', '=', meetingId)
      .$if(!includeStale, (query) => query.whereRef('meeting.revision', '=', 'result.revision'))
      .executeTakeFirst();
    if (!row) return null;
    return {
      meetingId: row.meeting_id,
      revision: Number(row.revision),
      status: row.status,
      title: row.title,
      summary: row.summary,
      decisions: JSON.parse(row.decisions_json) as LiveMeetingResultItem[],
      tasks: JSON.parse(row.tasks_json) as LiveMeetingResultTask[],
      openQuestions: JSON.parse(row.open_questions_json) as LiveMeetingResultItem[],
      model: row.model,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  async updateResultTask(
    sessionId: string,
    meetingId: string,
    revision: number,
    taskId: string,
    patch: { state: 'added' | 'dismissed'; taskId: string | null },
    ownerUserId?: string,
    expectedProjectId?: string,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const meeting = await trx
        .selectFrom('live_meetings')
        .select(['session_id', 'revision', 'speaker_names_json', 'title'])
        .where('id', '=', meetingId)
        .forUpdate()
        .executeTakeFirst();
      if (meeting?.session_id !== sessionId || Number(meeting.revision) !== revision) return false;
      const row = await trx
        .selectFrom('live_meeting_results')
        .selectAll()
        .where('meeting_id', '=', meetingId)
        .where('revision', '=', revision)
        .forUpdate()
        .executeTakeFirst();
      if (!row || row.status !== 'ready') return false;
      const tasks = JSON.parse(row.tasks_json) as LiveMeetingResultTask[];
      const task = tasks.find((item) => item.id === taskId);
      if (!task) return false;
      if (task.state !== 'proposed')
        return task.state === patch.state && task.taskId === patch.taskId;
      if (patch.state === 'added') {
        if (!ownerUserId || !patch.taskId) return false;
        const session = await trx
          .selectFrom('sessions')
          .select('project_id')
          .where('session_id', '=', sessionId)
          .forUpdate()
          .executeTakeFirst();
        if (!session?.project_id || session.project_id !== expectedProjectId) return false;
        const names = JSON.parse(meeting.speaker_names_json) as Record<string, string>;
        await new TaskStore(trx, this.cipher).upsert(
          {
            id: patch.taskId,
            ownerUserId,
            projectId: session.project_id,
            sourceSessionId: sessionId,
            origin: 'user',
            title: task.text,
            detail: [
              meeting.title || row.title || 'Meeting',
              task.speaker === null ? '' : names[task.speaker] || `Speaker ${task.speaker + 1}`,
              task.atSeconds === null
                ? ''
                : `${Math.floor(task.atSeconds / 60)}:${String(Math.floor(task.atSeconds % 60)).padStart(2, '0')}`,
              task.quote,
            ]
              .filter(Boolean)
              .join('\n'),
          },
          0,
        );
      }
      Object.assign(task, patch);
      await trx
        .updateTable('live_meeting_results')
        .set({ tasks_json: JSON.stringify(tasks), updated_at: Date.now(), filed_revision: null })
        .where('meeting_id', '=', meetingId)
        .execute();
      return true;
    });
  }

  /** Lock the meeting before checking its revision so a late model response cannot overwrite edits. */
  async saveResult(sessionId: string, result: LiveMeetingResult): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const meeting = await trx
        .selectFrom('live_meetings')
        .select(['session_id', 'revision'])
        .where('id', '=', result.meetingId)
        .forUpdate()
        .executeTakeFirst();
      if (meeting?.session_id !== sessionId || Number(meeting.revision) !== result.revision)
        return false;
      const values = {
        filed_revision: null,
        meeting_id: result.meetingId,
        revision: result.revision,
        status: result.status,
        title: result.title,
        summary: result.summary,
        decisions_json: JSON.stringify(result.decisions),
        tasks_json: JSON.stringify(result.tasks),
        open_questions_json: JSON.stringify(result.openQuestions),
        model: result.model,
        created_at: result.createdAt,
        updated_at: result.updatedAt,
      };
      await trx
        .insertInto('live_meeting_results')
        .values(values)
        .onConflict((oc) => oc.column('meeting_id').doUpdateSet(values))
        .execute();
      return true;
    });
  }

  async addInsight(
    sessionId: string,
    insight: LiveMeetingInsight,
    replace = false,
    revision?: number,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const meeting = await trx
        .selectFrom('live_meetings')
        .select(['session_id', 'revision'])
        .where('id', '=', insight.meetingId)
        .forUpdate()
        .executeTakeFirst();
      if (
        meeting?.session_id !== sessionId ||
        (revision !== undefined && Number(meeting.revision) !== revision)
      )
        return false;
      if (insight.kind === 'research' && !insight.id.startsWith('question-')) {
        const questions = await trx
          .selectFrom('live_meeting_insights')
          .select('evidence_a')
          .where('meeting_id', '=', insight.meetingId)
          .where('id', 'like', 'question-%')
          .execute();
        const key = (text: string) => text.trim().replace(/[.!?]+$/u, '');
        if (questions.some((question) => key(question.evidence_a) === key(insight.evidenceA)))
          return false;
      }
      await trx
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
    });
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
                resolved: false,
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
      const resolved = questions
        .filter(
          (question) =>
            classified?.resolvedIds.includes(question.id) &&
            !classified.acceptedIds.includes(question.id),
        )
        .map(({ id }) => id);
      if (resolved.length)
        await trx
          .updateTable('live_meeting_insights')
          .set({ resolved: true })
          .where('meeting_id', '=', meetingId)
          .where('id', 'in', resolved)
          .execute();
      // Keep resolved evidence so a later batch at the same revision cannot recreate the suggestion.
      const removed = questions
        .filter((question) => !meeting.transcript.includes(question.evidence_a))
        .map(({ id }) => id);
      const evidenceKey = (text: string) => text.trim().replace(/[.!?]+$/u, '');
      const acceptedEvidence = new Set(
        questions.map((question) => evidenceKey(question.evidence_a)),
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
      .where('resolved', '=', false)
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

  /** Whether this meeting was discarded. A tombstone outlives the meeting so neither a
   * late upload nor another device's sync can bring it back. */
  async isDeleted(sessionId: string, meetingId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('live_meeting_deletions')
      .select('meeting_id')
      .where('meeting_id', '=', meetingId)
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Permanently deletes a finished meeting: transcript, timed words, speaker turns and
   * edits, notes, insights, commands and the derived result all go with the meeting row.
   * Tasks already created from the result and session messages are kept. A recording
   * that may still change (an active one, or an online meeting still recovering) is
   * refused. The tombstone takes the next sync sequence so the change feed reports it.
   */
  async deleteMeeting(
    sessionId: string,
    meetingId: string,
  ): Promise<'deleted' | 'not_found' | 'running'> {
    return this.db.transaction().execute(async (trx) => {
      // The clock first, as every writer takes it: locking the meeting row before it
      // would invert the order `putMeeting` uses and could deadlock with an upload.
      const sequence = await this.nextUpdateSequence(trx);
      const meeting = await trx
        .selectFrom('live_meetings')
        .select(['session_id', 'state', 'engine', 'started_at'])
        .where('id', '=', meetingId)
        .forUpdate()
        .executeTakeFirst();
      if (meeting?.session_id !== sessionId) return 'not_found';
      // Same predicate as `running()`: an interrupted online meeting is still recovering.
      if (
        meeting.state === 'active' ||
        (meeting.engine === 'attendee' && meeting.state !== 'ended')
      )
        return 'running';
      await trx.deleteFrom('live_meetings').where('id', '=', meetingId).execute();
      await trx
        .insertInto('live_meeting_deletions')
        .values({
          meeting_id: meetingId,
          session_id: sessionId,
          deleted_seq: sequence,
          deleted_at: Date.now(),
          engine: meeting.engine,
          started_at: Number(meeting.started_at),
        })
        .onConflict((conflict) => conflict.column('meeting_id').doNothing())
        .execute();
      return 'deleted';
    });
  }

  /** The identity of one meeting, without its transcript. */
  async meetingHead(
    sessionId: string,
    meetingId: string,
  ): Promise<{ id: string; engine: string; startedAt: number; state: string } | null> {
    const row = await this.db
      .selectFrom('live_meetings')
      .select(['id', 'engine', 'started_at', 'state'])
      .where('session_id', '=', sessionId)
      .where('id', '=', meetingId)
      .executeTakeFirst();
    return row
      ? { id: row.id, engine: row.engine, startedAt: Number(row.started_at), state: row.state }
      : null;
  }

  /** A discarded meeting's identity, for repeating cleanup that failed the first time. */
  async deletion(
    sessionId: string,
    meetingId: string,
  ): Promise<{ id: string; engine: string; startedAt: number } | null> {
    const row = await this.db
      .selectFrom('live_meeting_deletions')
      .select(['meeting_id', 'engine', 'started_at'])
      .where('meeting_id', '=', meetingId)
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    return row
      ? { id: row.meeting_id, engine: row.engine, startedAt: Number(row.started_at) }
      : null;
  }

  private async tombstoned(db: Kysely<Database>, meetingId: string): Promise<boolean> {
    const row = await db
      .selectFrom('live_meeting_deletions')
      .select('meeting_id')
      .where('meeting_id', '=', meetingId)
      .executeTakeFirst();
    return row !== undefined;
  }

  async putMeeting(meeting: LiveMeetingSyncRecord): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      // The clock row lock serializes this upload against a concurrent deletion.
      const sequence = await this.nextUpdateSequence(trx);
      if (await this.tombstoned(trx, meeting.id)) return false;
      // A delayed recorder upload cannot reopen a meeting ended from another device.
      // Keep the owner revision unchanged at finalization so its final transcript can follow.
      if (meeting.engine !== 'attendee') {
        const current = await trx
          .selectFrom('live_meetings')
          .select(['state', 'ended_at'])
          .where('id', '=', meeting.id)
          .executeTakeFirst();
        if (current?.state === 'ended') {
          if (meeting.state === 'active') return false;
          meeting = {
            ...meeting,
            state: 'ended',
            endedAt: meeting.endedAt ?? Number(current.ended_at),
          };
        }
      }
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
          title: meeting.title ?? null,
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
              title: meeting.title === undefined ? sql.ref('live_meetings.title') : meeting.title,
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
        // Persist the job with the terminal revision: a crash after upload acknowledgement
        // must not leave a meeting without any recoverable result work.
        const now = Date.now();
        await trx
          .insertInto('live_meeting_results')
          .values({
            meeting_id: meeting.id,
            revision: meeting.revision,
            status: 'working',
            filed_revision: null,
            title: null,
            summary: null,
            decisions_json: '[]',
            tasks_json: '[]',
            open_questions_json: '[]',
            model: null,
            created_at: now,
            updated_at: now,
          })
          .onConflict((oc) =>
            oc
              .column('meeting_id')
              .doUpdateSet({
                revision: meeting.revision,
                status: 'working',
                filed_revision: null,
                title: null,
                summary: null,
                decisions_json: '[]',
                open_questions_json: '[]',
                model: null,
                updated_at: now,
              })
              .where('live_meeting_results.revision', '<', meeting.revision),
          )
          .execute();
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

  /** Ends server discovery without claiming that a remote microphone has stopped. */
  async finalizeMeeting(
    sessionId: string,
    meetingId: string,
  ): Promise<'finalized' | 'not_found' | 'provider_managed'> {
    return this.db.transaction().execute(async (trx) => {
      const sequence = await this.nextUpdateSequence(trx);
      const meeting = await trx
        .selectFrom('live_meetings')
        .select(['session_id', 'engine', 'state', 'revision', 'started_at'])
        .where('id', '=', meetingId)
        .forUpdate()
        .executeTakeFirst();
      if (meeting?.session_id !== sessionId) return 'not_found';
      if (meeting.engine === 'attendee') return 'provider_managed';
      if (meeting.state === 'ended') return 'finalized';
      const now = Date.now();
      await trx
        .updateTable('live_meetings')
        .set({
          state: 'ended',
          ended_at: Math.max(now, Number(meeting.started_at)),
          updated_seq: sequence,
        })
        .where('id', '=', meetingId)
        .execute();
      await trx
        .insertInto('live_meeting_results')
        .values({
          meeting_id: meetingId,
          revision: Number(meeting.revision),
          status: 'working',
          filed_revision: null,
          title: null,
          summary: null,
          decisions_json: '[]',
          tasks_json: '[]',
          open_questions_json: '[]',
          model: null,
          created_at: now,
          updated_at: now,
        })
        .onConflict((conflict) => conflict.column('meeting_id').doNothing())
        .execute();
      await trx
        .updateTable('live_meeting_commands')
        .set({
          state: sql`case when action = 'stop' then 'completed' else 'failed' end`,
          error: sql`case when action = 'stop' then null else 'Meeting finalized on server.' end`,
          acknowledged_at: now,
        })
        .where('meeting_id', '=', meetingId)
        .where('state', '=', 'pending')
        .execute();
      return 'finalized';
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

  /** Keep open device recordings discoverable when screen lock suspends their heartbeat.
   * Reachability describes freshness; only a terminal recorder state ends discovery. */
  async running(): Promise<
    Array<{
      sessionId: string;
      id: string;
      title: string | null;
      engine: string;
      startedAt: number;
      state: 'active' | 'interrupted';
      captureStatus: string;
      recorderLastSeenAt: number | null;
    }>
  > {
    const rows = await this.db
      .selectFrom('live_meetings')
      .select([
        'session_id',
        'id',
        'title',
        'engine',
        'started_at',
        'state',
        'capture_status',
        'recorder_last_seen_at',
      ])
      .where((eb) =>
        eb.or([
          eb.and([eb('engine', '=', 'attendee'), eb('state', '<>', 'ended')]),
          eb('state', '=', 'active'),
        ]),
      )
      .orderBy('started_at', 'desc')
      .execute();
    return rows.map((row) => ({
      sessionId: row.session_id,
      id: row.id,
      title: row.title,
      engine: row.engine,
      startedAt: Number(row.started_at),
      state: row.state === 'interrupted' ? 'interrupted' : 'active',
      captureStatus: row.capture_status,
      recorderLastSeenAt: row.engine === 'attendee' ? null : Number(row.recorder_last_seen_at),
    }));
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
    if (updated) return true;
    // Terminal uploads and server finalization can resolve stop before its recorder acks it.
    const existing = await this.db
      .selectFrom('live_meeting_commands as command')
      .innerJoin('live_meetings as meeting', 'meeting.id', 'command.meeting_id')
      .select(['command.state', 'command.error'])
      .where('command.id', '=', id)
      .where('meeting.id', '=', meetingId)
      .where('meeting.session_id', '=', sessionId)
      .where('meeting.owner_token_hash', '=', ownerTokenHash)
      .executeTakeFirst();
    return existing?.state === state && existing.error === error;
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
      // Checked after the clock lock: a deletion that committed meanwhile removed the
      // meeting, and the foreign key would otherwise be the only thing to notice.
      if (await this.tombstoned(trx, note.meetingId)) return false;
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
    /** Meetings discarded after `after`; devices delete them with their notes. */
    deletedMeetingIds: string[];
  }> {
    const snapshot = await sql<{ cursor: number | string }>`select greatest(
      coalesce((select max(updated_seq) from live_meetings where session_id = ${sessionId}), 0),
      coalesce((select max(n.updated_seq) from live_meeting_notes n
        join live_meetings m on m.id = n.meeting_id where m.session_id = ${sessionId}), 0),
      coalesce((select max(deleted_seq) from live_meeting_deletions
        where session_id = ${sessionId}), 0)
    ) as cursor`.execute(this.db);
    const cursor = Number(snapshot.rows[0]?.cursor ?? 0);
    const [meetings, notes, deletions] = await Promise.all([
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
      this.db
        .selectFrom('live_meeting_deletions')
        .select('meeting_id')
        .where('session_id', '=', sessionId)
        .where('deleted_seq', '>', after)
        .where('deleted_seq', '<=', cursor)
        .orderBy('deleted_seq')
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
        title: row.title,
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
      deletedMeetingIds: deletions.map((row) => row.meeting_id),
    };
  }
}
