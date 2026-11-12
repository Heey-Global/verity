import { type VerityClient, VerityApiError } from '@verity/mobile';
import { subscribeLiveRefresh } from './liveConnection';
import { AppState } from 'react-native';
import { createVerityClient, getActiveMeetingServerId, subscribeVerityBaseUrl } from './client';
import {
  currentMeeting,
  endMeeting,
  pauseMeeting,
  resumeMeeting,
  recoverNativeMeetings,
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
  meetingUploadFailure,
  saveMeetingUploadFailure,
  clearMeetingUploadFailure,
} from './liveMeetingStore';

const flushing = new Map<string, Promise<void>>();
let handlingCommand = false;
let followedRemote: { serverId: string; sessionId: string; meetingId: string } | null = null;
const followListeners = new Set<(value: typeof followedRemote) => void>();
export interface MeetingSyncFailure {
  message: string;
  status: number;
  serverFinalized?: boolean;
}
const syncFailures = new Map<string, MeetingSyncFailure>();
const failureListeners = new Set<() => void>();
const failureKey = (serverId: string, id: string) => JSON.stringify([serverId, id]);

export function getMeetingSyncFailure(serverId: string, id: string): MeetingSyncFailure | null {
  return syncFailures.get(failureKey(serverId, id)) ?? null;
}

export function subscribeMeetingSyncFailure(listener: () => void): () => void {
  failureListeners.add(listener);
  return () => {
    failureListeners.delete(listener);
  };
}

function publishFailure(serverId: string, id: string, failure: MeetingSyncFailure | null): void {
  const key = failureKey(serverId, id);
  if (JSON.stringify(syncFailures.get(key) ?? null) === JSON.stringify(failure)) return;
  if (failure) syncFailures.set(key, failure);
  else syncFailures.delete(key);
  for (const listener of failureListeners) listener();
}

const uploadFailureMessage =
  'The server could not accept the saved transcript. Your local copy is kept.';
// Reconnect + explicit retry can recover auth failures; throttling/timeouts remain retryable.
const permanentUploadError = (error: unknown): error is VerityApiError =>
  error instanceof VerityApiError && [400, 401, 403, 404, 409, 413, 422].includes(error.status);

async function uploadMeeting(
  client: VerityClient,
  serverId: string,
  meeting: Awaited<ReturnType<typeof pendingMeetings>>[number],
): Promise<void> {
  const blocked = await meetingUploadFailure(serverId, meeting.id);
  if (blocked?.status)
    publishFailure(serverId, meeting.id, { ...blocked, message: uploadFailureMessage });
  // Heartbeats and new speech advance revisions too; they do not repair validation/auth.
  // A terminal snapshot following a server-finalized conflict is allowed through once.
  if (
    blocked &&
    blocked.revision >= 0 &&
    !(blocked.status === 409 && meeting.state !== 'active' && blocked.revision !== meeting.revision)
  )
    throw new Error(uploadFailureMessage);
  try {
    await client.putLiveMeeting(meeting);
  } catch (error) {
    if (permanentUploadError(error) && !isDiscardedError(error)) {
      const failure = {
        revision: meeting.revision,
        status: error.status,
        serverFinalized: blocked?.serverFinalized ?? false,
      };
      await saveMeetingUploadFailure(serverId, meeting.id, failure);
      publishFailure(serverId, meeting.id, { ...failure, message: uploadFailureMessage });
      // Finalizing elsewhere never authorizes this recorder to reopen the meeting.
      if (error.code === 'meeting_finalized') {
        const current = currentMeeting();
        if (
          current?.id === meeting.id &&
          current.serverId === serverId &&
          current.state === 'active'
        )
          await endMeeting(meeting.id);
      }
    }
    throw error;
  }
  await acknowledgeMeeting(serverId, meeting.id, meeting.revision);
  await clearMeetingUploadFailure(serverId, meeting.id);
  publishFailure(serverId, meeting.id, null);
}

/** Explicit retry preserves the durable outbox and retries only after prior uploads settle. */
export async function retryMeetingSync(sessionId: string, meetingId: string): Promise<void> {
  const serverId = getActiveMeetingServerId();
  if (!serverId) throw new Error('Connect to this meeting’s server to retry sync.');
  await flushing.get(serverId)?.catch(() => undefined);
  const previous = await meetingUploadFailure(serverId, meetingId);
  if (previous) await saveMeetingUploadFailure(serverId, meetingId, { ...previous, revision: -1 });
  await flushOwnerMeeting(serverId, meetingId);
  await syncMeetingSession(sessionId);
}

/** Ends server state only; this never claims to stop another device's microphone. */
export async function finalizeMeetingOnServer(sessionId: string, meetingId: string): Promise<void> {
  const serverId = getActiveMeetingServerId();
  const client = createVerityClient();
  if (!serverId || !client) throw new Error('Connect to this meeting’s server to end it there.');
  const current = currentMeeting();
  if (current?.id === meetingId && current.state === 'active')
    throw new Error('Stop recording on this device before ending the meeting on the server.');
  await client.finalizeLiveMeeting(sessionId, meetingId);
  await recordServerFinalization(serverId, meetingId);
}

async function recordServerFinalization(serverId: string, meetingId: string): Promise<void> {
  const failure = await meetingUploadFailure(serverId, meetingId);
  if (failure) {
    await saveMeetingUploadFailure(serverId, meetingId, { ...failure, serverFinalized: true });
    publishFailure(serverId, meetingId, {
      ...failure,
      serverFinalized: true,
      message: uploadFailureMessage,
    });
  }
}

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
        await uploadMeeting(client, serverId, meeting);
      } catch (error) {
        // Discarded elsewhere: retrying would fail forever, so this copy goes too.
        // A failed local delete must not stop the rest of the outbox.
        if (isDiscardedError(error))
          await deleteMeeting(meeting.id, serverId).catch((reason: unknown) => {
            firstError ??= reason;
          });
        else firstError ??= error;
      }
    }
    for (const { sessionId, note } of await pendingNotes(serverId)) {
      try {
        // A rejected parent may not exist remotely; keep its notes local until recovery.
        if (await meetingUploadFailure(serverId, note.meetingId)) {
          firstError ??= new Error(uploadFailureMessage);
          continue;
        }
        await client.putLiveMeetingNote(sessionId, note);
        await acknowledgeNote(serverId, note.id, note.revision);
      } catch (error) {
        if (isDiscardedError(error))
          await deleteMeeting(note.meetingId, serverId).catch((reason: unknown) => {
            firstError ??= reason;
          });
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
    await uploadMeeting(client, serverId, meeting);
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
      if (!error) {
        try {
          await flushOwnerMeeting(meeting.serverId, meeting.id);
        } catch {
          if (command.action === 'stop') {
            try {
              await client.finalizeLiveMeeting(meeting.sessionId, meeting.id);
              await recordServerFinalization(meeting.serverId, meeting.id);
            } catch {
              error =
                'Recording stopped locally, but the server end could not be confirmed. Retry from the meeting.';
            }
          } else error = 'The recording changed locally, but its status could not be synced.';
        }
      }
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
  let lastBackgroundFlush = 0;
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
    const background = AppState.currentState !== 'active';
    // Reuse the paired transport while audio keeps the process alive. This is best effort;
    // the native journal remains authoritative when JavaScript or the connection is suspended.
    if (serverId && (!background || Date.now() - lastBackgroundFlush >= 10_000)) {
      if (background) lastBackgroundFlush = Date.now();
      void flushMeetingOutbox(serverId).catch(() => undefined);
    }
  };
  const detachMeeting = subscribeMeeting(bindMeeting);
  const detachBase = subscribeVerityBaseUrl(() => {
    client = createVerityClient();
    watchedKey = '';
    bindMeeting();
    void tick();
  });
  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active')
      void recoverNativeMeetings()
        .then(tick)
        .catch(() => undefined);
  });
  void recoverNativeMeetings()
    .then(tick)
    .catch(() => undefined);
  return () => {
    running = false;
    clearInterval(timer);
    detach();
    detachMeeting();
    detachBase();
    appState.remove();
  };
}
