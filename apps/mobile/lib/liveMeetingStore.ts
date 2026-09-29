import type * as SQLite from 'expo-sqlite';
import type { STTEngineId } from './liveMeetingSTT';

export interface MeetingRecord {
  id: string;
  sessionId: string;
  engine: STTEngineId;
  startedAt: number;
  endedAt: number | null;
  state: 'active' | 'interrupted' | 'ended';
  captureStatus?: 'preparing' | 'downloading' | 'listening' | 'paused';
  transcript: string;
  error: string | null;
}

export interface MeetingNote {
  id: string;
  meetingId: string;
  atSeconds: number;
  text: string;
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
    // A process exit ends capture even when iOS has no chance to send a final status.
    await connection.runAsync(
      "UPDATE meetings SET state = 'interrupted', ended_at = last_active_at, error = COALESCE(error, 'Capture stopped when the app closed.') WHERE state = 'active'",
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
): Promise<MeetingRecord> {
  const meeting: MeetingRecord = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    sessionId,
    engine,
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    captureStatus: 'preparing',
    transcript: '',
    error: null,
  };
  const connection = await db();
  await connection.runAsync(
    'INSERT INTO meetings (id, session_id, engine, started_at, last_active_at, state, transcript) VALUES (?, ?, ?, ?, ?, ?, ?)',
    meeting.id,
    meeting.sessionId,
    meeting.engine,
    meeting.startedAt,
    meeting.startedAt,
    meeting.state,
    meeting.transcript,
  );
  return meeting;
}

export async function saveTranscript(id: string, transcript: string): Promise<void> {
  await (
    await db()
  ).runAsync(
    'UPDATE meetings SET transcript = ?, last_active_at = ? WHERE id = ?',
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
    "UPDATE meetings SET state = ?, error = ?, ended_at = CASE WHEN ? != 'active' THEN ? ELSE ended_at END WHERE id = ?",
    state,
    error,
    state,
    Date.now(),
    id,
  );
}

export async function listMeetings(sessionId: string): Promise<MeetingRecord[]> {
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
    error: string | null;
  }>(
    'SELECT id, session_id, engine, started_at, ended_at, state, transcript, error FROM meetings WHERE session_id = ? ORDER BY started_at DESC',
    sessionId,
  );
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    engine: row.engine,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    state: row.state,
    transcript: row.transcript,
    error: row.error,
  }));
}

export async function listNotes(meetingId: string): Promise<MeetingNote[]> {
  const rows = await (
    await db()
  ).getAllAsync<{ id: string; meeting_id: string; at_seconds: number; text: string }>(
    'SELECT * FROM meeting_notes WHERE meeting_id = ? ORDER BY at_seconds, id',
    meetingId,
  );
  return rows.map((row) => ({
    id: row.id,
    meetingId: row.meeting_id,
    atSeconds: row.at_seconds,
    text: row.text,
  }));
}

export function saveNote(note: MeetingNote): Promise<void> {
  const previous = noteWrites.get(note.id) ?? Promise.resolve();
  const write = previous
    .catch(() => undefined)
    .then(async () => {
      await (
        await db()
      ).runAsync(
        'INSERT INTO meeting_notes (id, meeting_id, at_seconds, text) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET text = excluded.text, at_seconds = excluded.at_seconds',
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
