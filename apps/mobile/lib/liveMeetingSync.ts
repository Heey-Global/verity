import { type VerityClient, VerityApiError } from '@verity/mobile';
import { subscribeLiveRefresh } from './liveConnection';
import { AppState } from 'react-native';
import { createVerityClient, getActiveMeetingServerId, subscribeVerityBaseUrl } from './client';
import {
  currentMeeting,
  endMeeting,
  pauseMeeting,
  resumeMeeting,
  subscribeMeeting,
} from './liveMeetingSession';
import {
  acknowledgeMeeting,
  acknowledgeNote,
  deleteMeeting,
  getSyncCursor,
  hasPendingMeetingSync,
  importChanges,
  pendingMeetings,
  pendingNotes,
} from './liveMeetingStore';

const flushing = new Map<string, Promise<void>>();
let handlingCommand = false;
let followedRemote: { serverId: string; sessionId: string; meetingId: string } | null = null;
const followListeners = new Set<(value: typeof followedRemote) => void>();

export function followRemoteMeeting(sessionId: string, meetingId: string): void {
  const serverId = getActiveMeetingServerId();
  if (!serverId) return;
  followedRemote = { serverId, sessionId, meetingId };
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

const isDiscardedError = (error: unknown) =>
  error instanceof VerityApiError && error.status === 409 && error.code === 'meeting_deleted';

/**
 * Discards a finished meeting: on its server for every device when it was shared, then
 * on this device. A meeting saved only here is deleted locally. Throws when the meeting
 * is still recording or its server is not the connected one; nothing is deleted then.
 */
export async function discardFinishedMeeting(
  sessionId: string,
  meeting: { id: string; serverId?: string | null; state: string; engine?: string },
  suppliedClient?: VerityClient,
): Promise<void> {
  // Same rule as the server: an online meeting is finished only once it has ended.
  if (meeting.state === 'active' || (meeting.engine === 'attendee' && meeting.state !== 'ended'))
    throw new Error('End the meeting before discarding it.');
  if (meeting.serverId != null) {
    if (meeting.serverId !== getActiveMeetingServerId())
      throw new Error('Reconnect to this meeting’s server to discard it.');
    const client = suppliedClient ?? createVerityClient();
    if (!client) throw new Error('Connect to your server to discard this meeting.');
    // An upload already on its way would otherwise create the meeting after the delete.
    await flushing.get(meeting.serverId)?.catch(() => undefined);
    try {
      await client.discardSessionMeeting(sessionId, meeting.id);
    } catch (error) {
      // Never uploaded: only this copy is left. Any other 404 (an older server without
      // discarding, an unknown session) keeps the meeting and reports the failure.
      if (!(
        error instanceof VerityApiError &&
        error.status === 404 &&
        error.code === 'meeting_not_found'
      ))
        throw error;
    }
  }
  await deleteMeeting(meeting.id, meeting.serverId ?? null);
}

function flushMeetingOutbox(serverId: string): Promise<void> {
  const inFlight = flushing.get(serverId);
  if (inFlight) return inFlight;
  const run = (async () => {
    if (getActiveMeetingServerId() !== serverId) return;
    const client = createVerityClient();
    if (!client) return;
    let firstError: unknown = null;
    for (const meeting of await pendingMeetings(serverId)) {
      try {
        await client.putLiveMeeting(meeting);
        await acknowledgeMeeting(serverId, meeting.id, meeting.revision);
      } catch (error) {
        // Discarded elsewhere: retrying would fail forever, so this copy goes too.
        if (isDiscardedError(error)) await deleteMeeting(meeting.id, serverId);
        else firstError ??= error;
      }
    }
    for (const { sessionId, note } of await pendingNotes(serverId)) {
      try {
        await client.putLiveMeetingNote(sessionId, note);
        await acknowledgeNote(serverId, note.id, note.revision);
      } catch (error) {
        if (isDiscardedError(error)) await deleteMeeting(note.meetingId, serverId);
        else firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  })();
  flushing.set(serverId, run);
  void run
    .finally(() => {
      if (flushing.get(serverId) === run) flushing.delete(serverId);
    })
    .catch(() => undefined);
  return run;
}

export async function syncMeetingSession(
  sessionId: string,
  suppliedClient?: VerityClient,
): Promise<{ pending: boolean }> {
  const serverId = getActiveMeetingServerId();
  if (!serverId) return { pending: true };
  let pending = false;
  try {
    await flushMeetingOutbox(serverId);
  } catch {
    pending = true;
  }
  const client = suppliedClient ?? createVerityClient();
  if (!client) return { pending: true };
  if (getActiveMeetingServerId() !== serverId) return { pending: true };
  const after = await getSyncCursor(serverId, sessionId);
  const changes = await client.getLiveMeetingChanges(sessionId, after);
  await importChanges(
    serverId,
    sessionId,
    changes.cursor,
    changes.meetings,
    changes.notes,
    changes.deletedMeetingIds,
  );
  return { pending: pending || (await hasPendingMeetingSync(serverId, sessionId)) };
}

async function flushOwnerMeeting(serverId: string, id: string): Promise<void> {
  if (getActiveMeetingServerId() !== serverId) throw new Error('Recording server changed.');
  const client = createVerityClient();
  if (!client) throw new Error('Server unavailable.');
  for (const meeting of (await pendingMeetings(serverId)).filter((item) => item.id === id)) {
    await client.putLiveMeeting(meeting);
    await acknowledgeMeeting(serverId, meeting.id, meeting.revision);
  }
}

async function handleOwnerCommands(suppliedClient?: VerityClient): Promise<void> {
  if (handlingCommand) return;
  const meeting = currentMeeting();
  if (
    !meeting ||
    !meeting.ownerToken ||
    !meeting.serverId ||
    meeting.serverId !== getActiveMeetingServerId()
  )
    return;
  const client = suppliedClient ?? createVerityClient();
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
        if (getActiveMeetingServerId() !== meeting.serverId)
          throw new Error('Recording server changed before the remote command was applied.');
        if (command.action !== 'stop' && current.state !== 'active')
          throw new Error('Recording already ended.');
        if (command.action === 'pause') await pauseMeeting(meeting.id);
        else if (command.action === 'resume') await resumeMeeting(meeting.id);
        else await endMeeting(meeting.id);
      } catch (reason) {
        error = String(reason);
      }
      if (!error) await flushOwnerMeeting(meeting.serverId, meeting.id);
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
  let client = createVerityClient();
  const tick = async () => {
    if (!running || ticking || AppState.currentState !== 'active') return;
    ticking = true;
    try {
      const serverId = getActiveMeetingServerId();
      if (serverId) await flushMeetingOutbox(serverId).catch(() => undefined);
      await handleOwnerCommands(client ?? undefined);
    } catch {
      // Local SQLite remains the source of truth until the server can be reached again.
    } finally {
      ticking = false;
    }
  };
  // This timer retries local durable writes, rather than polling server state.
  const timer = setInterval(() => {
    const serverId = getActiveMeetingServerId();
    if (serverId && AppState.currentState === 'active')
      void Promise.all([pendingMeetings(serverId), pendingNotes(serverId)])
        .then(([meetings, notes]) => {
          if (running && (meetings.length > 0 || notes.length > 0))
            void flushMeetingOutbox(serverId).catch(() => undefined);
        })
        .catch(() => undefined);
  }, 2000);
  let detach = () => {};
  let watchedKey = '';
  const bindMeeting = (): void => {
    const meeting = currentMeeting();
    const key = JSON.stringify([
      client?.liveBaseUrl?.(),
      meeting?.serverId,
      meeting?.sessionId,
      meeting?.id,
      meeting?.ownerToken,
    ]);
    if (key !== watchedKey) {
      watchedKey = key;
      detach();
      detach = () => {};
      if (client && meeting?.ownerToken && meeting.serverId === getActiveMeetingServerId()) {
        const path = `/sessions/${encodeURIComponent(meeting.sessionId)}/live-meetings/${encodeURIComponent(meeting.id)}/commands`;
        detach = subscribeLiveRefresh(client, tick, (value) => value === path, [
          { path, ownerToken: meeting.ownerToken },
        ]);
      }
    }
    const serverId = getActiveMeetingServerId();
    if (serverId) void flushMeetingOutbox(serverId).catch(() => undefined);
  };
  const detachMeeting = subscribeMeeting(bindMeeting);
  const detachBase = subscribeVerityBaseUrl(() => {
    client = createVerityClient();
    watchedKey = '';
    bindMeeting();
    void tick();
  });
  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') void tick();
  });
  void tick();
  return () => {
    running = false;
    clearInterval(timer);
    detach();
    detachMeeting();
    detachBase();
    appState.remove();
  };
}
