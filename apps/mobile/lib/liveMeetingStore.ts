import type * as SQLite from 'expo-sqlite';
import type { STTEngineId } from './liveMeetingSTT';
import { getRandomBytesAsync } from 'expo-crypto';
import type { LiveMeeting, LiveMeetingNote } from '@verity/mobile';
import { getActiveMeetingServerId } from './client';

export interface MeetingRecord {
  id: string;
  sessionId: string;
  serverId?: string | null;
  engine: STTEngineId;
  startedAt: number;
  endedAt: number | null;
  state: 'active' | 'interrupted' | 'ended';
  captureStatus?: 'preparing' | 'downloading' | 'listening' | 'paused';
  transcript: string;
  expectedParticipants?: number | null;
  error: string | null;
  ownerToken?: string | null;
  revision?: number;
  syncedRevision?: number;
}

export interface MeetingNote {
  id: string;
  meetingId: string;
  atSeconds: number;
  text: string;
  revision?: number;
  syncedRevision?: number;
}

let database: Promise<SQLite.SQLiteDatabase> | null = null;
const noteWrites = new Map<string, Promise<void>>();

async function db(): Promise<SQLite.SQLiteDatabase> {
  database ??= (async () => {
    // Delay native module loading so older installed builds can still open the app.
    const { openDatabaseAsync } = require('expo-sqlite') as typeof SQLite;
    const connection = await openDatabaseAsync('verity-meetings.db');
    await connection.execAsync(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, engine TEXT NOT NULL, started_at INTEGER NOT NULL,
        ended_at INTEGER, last_active_at INTEGER NOT NULL, state TEXT NOT NULL,
        transcript TEXT NOT NULL DEFAULT '', error TEXT
      );
      CREATE INDEX IF NOT EXISTS meetings_session ON meetings(session_id, started_at DESC);
      CREATE TABLE IF NOT EXISTS meeting_notes (
        id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, at_seconds REAL NOT NULL, text TEXT NOT NULL,
        FOREIGN KEY(meeting_id) REFERENCES meetings(id)
      );
      CREATE INDEX IF NOT EXISTS notes_meeting ON meeting_notes(meeting_id, at_seconds);`);
    const meetingColumns = await connection.getAllAsync<{ name: string }>(
      'PRAGMA table_info(meetings)',
    );
    const noteColumns = await connection.getAllAsync<{ name: string }>(
      'PRAGMA table_info(meeting_notes)',
    );
    for (const [name, definition] of [
      ['owner_token', 'TEXT'],
      ['revision', 'INTEGER NOT NULL DEFAULT 0'],
      ['synced_revision', 'INTEGER NOT NULL DEFAULT 0'],
      ['capture_status', "TEXT NOT NULL DEFAULT 'preparing'"],
      ['is_remote', 'INTEGER NOT NULL DEFAULT 0'],
      ['server_id', 'TEXT'],
      ['expected_participants', 'INTEGER'],
    ]) {
      if (!meetingColumns.some((column) => column.name === name))
        await connection.execAsync(`ALTER TABLE meetings ADD COLUMN ${name} ${definition}`);
    }
    for (const name of ['revision', 'synced_revision']) {
      if (!noteColumns.some((column) => column.name === name))
        await connection.execAsync(
          `ALTER TABLE meeting_notes ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`,
        );
    }
    if (!noteColumns.some((column) => column.name === 'finalized'))
      await connection.execAsync(
        'ALTER TABLE meeting_notes ADD COLUMN finalized INTEGER NOT NULL DEFAULT 1',
      );
    const legacy = await connection.getAllAsync<{ id: string }>(
      'SELECT id FROM meetings WHERE owner_token IS NULL AND is_remote = 0',
    );
    for (const row of legacy) {
      const token = Array.from(await getRandomBytesAsync(32), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      await connection.runAsync(
        'UPDATE meetings SET owner_token = ?, revision = MAX(revision, 1) WHERE id = ?',
        token,
        row.id,
      );
    }
    await connection.runAsync(
      'UPDATE meeting_notes SET revision = 1 WHERE revision = 0 AND meeting_id IN (SELECT id FROM meetings WHERE is_remote = 0)',
    );
    const cursorColumns = await connection.getAllAsync<{ name: string }>(
      'PRAGMA table_info(meeting_sync_cursors)',
    );
    if (cursorColumns.length > 0 && !cursorColumns.some((column) => column.name === 'server_id'))
      await connection.execAsync('DROP TABLE meeting_sync_cursors');
    await connection.execAsync(
      'CREATE TABLE IF NOT EXISTS meeting_sync_cursors (server_id TEXT NOT NULL, session_id TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(server_id, session_id))',
    );
    // A process exit ends capture even when iOS has no chance to send a final status.
    await connection.runAsync(
      "UPDATE meetings SET state = 'interrupted', ended_at = last_active_at, revision = revision + 1, error = COALESCE(error, 'Capture stopped when the app closed.') WHERE state = 'active' AND owner_token IS NOT NULL",
    );
    return connection;
  })();
  try {
    return await database;
  } catch (error) {
    database = null;
    throw error;
  }
}

export async function createMeeting(
  sessionId: string,
  engine: STTEngineId,
  expectedParticipants: number | null = null,
): Promise<MeetingRecord> {
  const meeting: MeetingRecord = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    sessionId,
    serverId: getActiveMeetingServerId(),
    engine,
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    captureStatus: 'preparing',
    transcript: '',
    expectedParticipants,
    error: null,
    ownerToken: Array.from(await getRandomBytesAsync(32), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join(''),
    revision: 1,
    syncedRevision: 0,
  };
  const connection = await db();
  await connection.runAsync(
    'INSERT INTO meetings (id, session_id, server_id, engine, started_at, last_active_at, state, transcript, owner_token, revision, expected_participants) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    meeting.id,
    meeting.sessionId,
    meeting.serverId ?? null,
    meeting.engine,
    meeting.startedAt,
    meeting.startedAt,
    meeting.state,
    meeting.transcript,
    meeting.ownerToken!,
    meeting.revision!,
    expectedParticipants,
  );
  return meeting;
}

export async function saveTranscript(id: string, transcript: string): Promise<void> {
  await (
    await db()
  ).runAsync(
    'UPDATE meetings SET transcript = ?, last_active_at = ?, revision = revision + 1 WHERE id = ?',
    transcript,
    Date.now(),
    id,
  );
}

export async function touchMeeting(id: string): Promise<void> {
  await (
    await db()
  ).runAsync('UPDATE meetings SET last_active_at = ? WHERE id = ?', Date.now(), id);
}

export async function setMeetingState(
  id: string,
  state: MeetingRecord['state'],
  error: string | null = null,
): Promise<void> {
  await (
    await db()
  ).runAsync(
    "UPDATE meetings SET state = ?, error = ?, ended_at = CASE WHEN ? != 'active' THEN ? ELSE ended_at END, revision = revision + 1 WHERE id = ?",
    state,
    error,
    state,
    Date.now(),
    id,
  );
}

export async function setCaptureStatus(
  id: string,
  status: NonNullable<MeetingRecord['captureStatus']>,
): Promise<void> {
  await (
    await db()
  ).runAsync(
    'UPDATE meetings SET capture_status = ?, revision = revision + 1 WHERE id = ?',
    status,
    id,
  );
}

export async function listMeetings(sessionId: string): Promise<MeetingRecord[]> {
  const serverId = getActiveMeetingServerId();
  const rows = await (
    await db()
  ).getAllAsync<{
    id: string;
    session_id: string;
    server_id: string | null;
    engine: STTEngineId;
    started_at: number;
    ended_at: number | null;
    state: MeetingRecord['state'];
    transcript: string;
    expected_participants: number | null;
    error: string | null;
    owner_token: string | null;
    revision: number;
    synced_revision: number;
    capture_status: MeetingRecord['captureStatus'];
  }>(
    'SELECT id, session_id, server_id, engine, started_at, ended_at, state, transcript, error, owner_token, revision, synced_revision, capture_status, expected_participants FROM meetings WHERE session_id = ? AND (server_id IS ? OR server_id IS NULL) ORDER BY (server_id IS NULL), started_at DESC',
    sessionId,
    serverId,
  );
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    serverId: row.server_id,
    engine: row.engine,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    state: row.state,
    transcript: row.transcript,
    expectedParticipants: row.expected_participants,
    error: row.error,
    ownerToken: row.owner_token,
    revision: row.revision,
    syncedRevision: row.synced_revision,
    captureStatus: row.capture_status,
  }));
}

export async function listNotes(meetingId: string): Promise<MeetingNote[]> {
  const rows = await (
    await db()
  ).getAllAsync<{
    id: string;
    meeting_id: string;
    at_seconds: number;
    text: string;
    revision: number;
    synced_revision: number;
  }>(
    'SELECT * FROM meeting_notes WHERE meeting_id = ? AND finalized = 1 ORDER BY at_seconds, id',
    meetingId,
  );
  return rows.map((row) => ({
    id: row.id,
    meetingId: row.meeting_id,
    atSeconds: row.at_seconds,
    text: row.text,
    revision: row.revision,
    syncedRevision: row.synced_revision,
  }));
}

export async function loadDraftNote(meetingId: string): Promise<MeetingNote | null> {
  const row = await (
    await db()
  ).getFirstAsync<{
    id: string;
    at_seconds: number;
    text: string;
  }>(
    'SELECT id, at_seconds, text FROM meeting_notes WHERE meeting_id = ? AND finalized = 0 ORDER BY rowid DESC LIMIT 1',
    meetingId,
  );
  return row ? { id: row.id, meetingId, atSeconds: row.at_seconds, text: row.text } : null;
}

export function saveNote(note: MeetingNote): Promise<void> {
  const previous = noteWrites.get(note.id) ?? Promise.resolve();
  const write = previous
    .catch(() => undefined)
    .then(async () => {
      await (
        await db()
      ).runAsync(
        'INSERT INTO meeting_notes (id, meeting_id, at_seconds, text, revision, finalized) VALUES (?, ?, ?, ?, 1, 0) ON CONFLICT(id) DO UPDATE SET text = excluded.text, at_seconds = excluded.at_seconds, revision = meeting_notes.revision + 1, finalized = 0',
        note.id,
        note.meetingId,
        note.atSeconds,
        note.text,
      );
    });
  noteWrites.set(note.id, write);
  const clear = () => {
    if (noteWrites.get(note.id) === write) noteWrites.delete(note.id);
  };
  void write.then(clear, clear);
  return write;
}

export async function finalizeNote(id: string, text: string): Promise<boolean> {
  await (noteWrites.get(id) ?? Promise.resolve());
  const result = await (
    await db()
  ).runAsync(
    'UPDATE meeting_notes SET finalized = 1, revision = revision + 1 WHERE id = ? AND text = ? AND finalized = 0',
    id,
    text,
  );
  return result.changes > 0;
}

export async function pendingMeetings(
  serverId: string,
): Promise<(LiveMeeting & { ownerToken: string })[]> {
  const rows = await (
    await db()
  ).getAllAsync<{
    id: string;
    session_id: string;
    engine: STTEngineId;
    started_at: number;
    ended_at: number | null;
    state: MeetingRecord['state'];
    transcript: string;
    capture_status: NonNullable<MeetingRecord['captureStatus']>;
    owner_token: string;
    revision: number;
  }>(
    'SELECT * FROM meetings WHERE server_id = ? AND owner_token IS NOT NULL AND revision > synced_revision ORDER BY started_at',
    serverId,
  );
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    engine: row.engine,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    state: row.state,
    transcript: row.transcript,
    captureStatus: row.capture_status,
    ownerToken: row.owner_token,
    revision: row.revision,
  }));
}

export async function pendingNotes(
  serverId: string,
): Promise<{ sessionId: string; note: LiveMeetingNote }[]> {
  const rows = await (
    await db()
  ).getAllAsync<{
    id: string;
    meeting_id: string;
    session_id: string;
    at_seconds: number;
    text: string;
    revision: number;
  }>(
    'SELECT n.*, m.session_id FROM meeting_notes n JOIN meetings m ON m.id = n.meeting_id WHERE m.server_id = ? AND n.finalized = 1 AND n.revision > n.synced_revision ORDER BY m.started_at, n.at_seconds',
    serverId,
  );
  return rows.map((row) => ({
    sessionId: row.session_id,
    note: {
      id: row.id,
      meetingId: row.meeting_id,
      atSeconds: row.at_seconds,
      text: row.text,
      revision: row.revision,
    },
  }));
}

export async function acknowledgeMeeting(
  serverId: string,
  id: string,
  revision: number,
): Promise<void> {
  await (
    await db()
  ).runAsync(
    'UPDATE meetings SET synced_revision = MAX(synced_revision, ?) WHERE server_id = ? AND id = ? AND revision >= ?',
    revision,
    serverId,
    id,
    revision,
  );
}

export async function acknowledgeNote(
  serverId: string,
  id: string,
  revision: number,
): Promise<void> {
  await (
    await db()
  ).runAsync(
    'UPDATE meeting_notes SET synced_revision = MAX(synced_revision, ?) WHERE id = ? AND revision >= ? AND EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_notes.meeting_id AND m.server_id = ?)',
    revision,
    id,
    revision,
    serverId,
  );
}

export async function getSyncCursor(serverId: string, sessionId: string): Promise<number> {
  const row = await (
    await db()
  ).getFirstAsync<{ cursor: number }>(
    'SELECT cursor FROM meeting_sync_cursors WHERE server_id = ? AND session_id = ?',
    serverId,
    sessionId,
  );
  return row?.cursor ?? 0;
}

export async function hasPendingMeetingSync(serverId: string, sessionId: string): Promise<boolean> {
  const row = await (
    await db()
  ).getFirstAsync<{ pending: number }>(
    `SELECT EXISTS(
      SELECT 1 FROM meetings WHERE server_id = ? AND session_id = ? AND owner_token IS NOT NULL AND revision > synced_revision
      UNION ALL
      SELECT 1 FROM meeting_notes n JOIN meetings m ON m.id = n.meeting_id
        WHERE m.server_id = ? AND m.session_id = ? AND n.finalized = 1 AND n.revision > n.synced_revision
    ) AS pending`,
    serverId,
    sessionId,
    serverId,
    sessionId,
  );
  return row?.pending === 1;
}

export async function importChanges(
  serverId: string,
  sessionId: string,
  cursor: number,
  meetings: LiveMeeting[],
  notes: LiveMeetingNote[],
): Promise<void> {
  const connection = await db();
  await connection.withTransactionAsync(async () => {
    for (const meeting of meetings) {
      await connection.runAsync(
        `INSERT INTO meetings
        (id, session_id, server_id, engine, started_at, last_active_at, ended_at, state, transcript, capture_status, revision, synced_revision, is_remote)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(id) DO UPDATE SET ended_at=excluded.ended_at, state=excluded.state,
          transcript=excluded.transcript, capture_status=excluded.capture_status,
          revision=excluded.revision, synced_revision=excluded.revision
        WHERE meetings.server_id = excluded.server_id AND meetings.owner_token IS NULL AND meetings.revision < excluded.revision`,
        meeting.id,
        sessionId,
        serverId,
        meeting.engine,
        meeting.startedAt,
        meeting.endedAt ?? meeting.startedAt,
        meeting.endedAt,
        meeting.state,
        meeting.transcript,
        meeting.captureStatus,
        meeting.revision,
        meeting.revision,
      );
      const existing = await connection.getFirstAsync<{ server_id: string | null }>(
        'SELECT server_id FROM meetings WHERE id = ?',
        meeting.id,
      );
      if (existing?.server_id !== serverId)
        throw new Error('Meeting ID belongs to another server.');
    }
    for (const note of notes) {
      await connection.runAsync(
        `INSERT INTO meeting_notes (id, meeting_id, at_seconds, text, revision, synced_revision, finalized)
        VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET text=excluded.text,
        at_seconds=excluded.at_seconds, revision=excluded.revision, synced_revision=excluded.revision
        WHERE meeting_notes.meeting_id = excluded.meeting_id AND meeting_notes.revision <= meeting_notes.synced_revision AND meeting_notes.revision < excluded.revision`,
        note.id,
        note.meetingId,
        note.atSeconds,
        note.text,
        note.revision,
        note.revision,
      );
      const existing = await connection.getFirstAsync<{ meeting_id: string }>(
        'SELECT meeting_id FROM meeting_notes WHERE id = ?',
        note.id,
      );
      if (existing?.meeting_id !== note.meetingId)
        throw new Error('Note ID belongs to another meeting.');
    }
    await connection.runAsync(
      'INSERT INTO meeting_sync_cursors (server_id, session_id, cursor) VALUES (?, ?, ?) ON CONFLICT(server_id, session_id) DO UPDATE SET cursor = MAX(cursor, excluded.cursor)',
      serverId,
      sessionId,
      cursor,
    );
  });
}
