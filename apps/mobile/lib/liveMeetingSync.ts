import { AppState } from 'react-native';
import { createVerityClient } from './client';
import { currentMeeting, endMeeting, pauseMeeting, resumeMeeting } from './liveMeetingSession';
import {
  acknowledgeMeeting,
  acknowledgeNote,
  getSyncCursor,
  hasPendingMeetingSync,
  importChanges,
  pendingMeetings,
  pendingNotes,
} from './liveMeetingStore';

let flushing: Promise<void> | null = null;
let handlingCommand = false;
let followedRemote: { sessionId: string; meetingId: string } | null = null;
const followListeners = new Set<(value: typeof followedRemote) => void>();

export function followRemoteMeeting(sessionId: string, meetingId: string): void {
  followedRemote = { sessionId, meetingId };
  for (const listener of followListeners) listener(followedRemote);
}

export function clearFollowedRemoteMeeting(): void {
  followedRemote = null;
  for (const listener of followListeners) listener(null);
}

export function subscribeFollowedRemoteMeeting(
  listener: (value: typeof followedRemote) => void,
): () => void {
  followListeners.add(listener);
  listener(followedRemote);
  return () => {
    followListeners.delete(listener);
  };
}

function flushMeetingOutbox(): Promise<void> {
  if (flushing) return flushing;
  const run = (async () => {
    const client = createVerityClient();
    if (!client) return;
    let firstError: unknown = null;
    for (const meeting of await pendingMeetings()) {
      try {
        await client.putLiveMeeting(meeting);
        await acknowledgeMeeting(meeting.id, meeting.revision);
      } catch (error) {
        firstError ??= error;
      }
    }
    for (const { sessionId, note } of await pendingNotes()) {
      try {
        await client.putLiveMeetingNote(sessionId, note);
        await acknowledgeNote(note.id, note.revision);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  })();
  flushing = run;
  void run
    .finally(() => {
      if (flushing === run) flushing = null;
    })
    .catch(() => undefined);
  return run;
}

export async function syncMeetingSession(sessionId: string): Promise<{ pending: boolean }> {
  let pending = false;
  try {
    await flushMeetingOutbox();
  } catch {
    pending = true;
  }
  const client = createVerityClient();
  if (!client) return { pending: true };
  const after = await getSyncCursor(sessionId);
  const changes = await client.getLiveMeetingChanges(sessionId, after);
  await importChanges(sessionId, changes.cursor, changes.meetings, changes.notes);
  return { pending: pending || (await hasPendingMeetingSync(sessionId)) };
}

async function flushOwnerMeeting(id: string): Promise<void> {
  const client = createVerityClient();
  if (!client) throw new Error('Server unavailable.');
  for (const meeting of (await pendingMeetings()).filter((item) => item.id === id)) {
    await client.putLiveMeeting(meeting);
    await acknowledgeMeeting(meeting.id, meeting.revision);
  }
}

async function handleOwnerCommands(): Promise<void> {
  if (handlingCommand) return;
  const meeting = currentMeeting();
  if (!meeting || !meeting.ownerToken) return;
  const client = createVerityClient();
  if (!client) return;
  handlingCommand = true;
  try {
    const { commands } = await client.getLiveMeetingCommands(
      meeting.sessionId,
      meeting.id,
      meeting.ownerToken,
    );
    for (const command of [...commands].reverse()) {
      if (command.state !== 'pending') continue;
      let error: string | null = null;
      try {
        const current = currentMeeting();
        if (current?.id !== meeting.id)
          throw new Error('Recording changed before the remote command was applied.');
        if (command.action !== 'stop' && current.state !== 'active')
          throw new Error('Recording already ended.');
        if (command.action === 'pause') await pauseMeeting(meeting.id);
        else if (command.action === 'resume') await resumeMeeting(meeting.id);
        else await endMeeting(meeting.id);
      } catch (reason) {
        error = String(reason);
      }
      if (!error) await flushOwnerMeeting(meeting.id);
      await client.acknowledgeLiveMeetingCommand(
        meeting.sessionId,
        meeting.id,
        command.id,
        meeting.ownerToken,
        error ? 'failed' : 'completed',
        error,
      );
    }
  } finally {
    handlingCommand = false;
  }
}

export function startLiveMeetingSync(): () => void {
  let running = true;
  let ticking = false;
  const tick = async () => {
    if (!running || ticking || AppState.currentState !== 'active') return;
    ticking = true;
    try {
      await flushMeetingOutbox().catch(() => undefined);
      await handleOwnerCommands();
    } catch {
      // Local SQLite remains the source of truth until the server can be reached again.
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, 2000);
  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') void tick();
  });
  void tick();
  return () => {
    running = false;
    clearInterval(timer);
    appState.remove();
  };
}
