import { liveMeetingSTT, type STTEvent, type STTEngineId } from './liveMeetingSTT';
import {
  applySTTEvent,
  emptySTTTranscript,
  transcriptText,
  type STTTranscriptState,
} from './liveMeetingSTTTranscript';
import {
  createMeeting,
  setMeetingState,
  saveTranscript,
  touchMeeting,
  type MeetingRecord,
} from './liveMeetingStore';

type Listener = (meeting: MeetingRecord | null) => void;

let active: MeetingRecord | null = null;
let transcript: STTTranscriptState = emptySTTTranscript;
let subscription: { remove(): void } | null = null;
let writeTail: Promise<void> = Promise.resolve();
let saveError: Error | null = null;
let ending = false;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let startInFlight: Promise<MeetingRecord> | null = null;
let shutdownInFlight: Promise<void> | null = null;
let shutdownFailed = false;
const pendingSaveSettlements = new Set<Promise<void>>();
const listeners = new Set<Listener>();

function publish() {
  for (const listener of listeners) listener(active);
}

function enqueueWrite(write: () => Promise<void>): Promise<void> {
  const next = writeTail.then(write);
  // Keep the next write possible while still reporting this failure to its caller.
  writeTail = next.catch(() => undefined);
  return next;
}

function stopHeartbeat() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}

function failLocalSave(id: string, error: unknown) {
  if (active?.id !== id) return;
  const wasCapturing = active.state === 'active';
  saveError = error instanceof Error ? error : new Error(String(error));
  active = {
    ...active,
    state: 'interrupted',
    endedAt: active.endedAt ?? Date.now(),
    error: `Local save failed: ${String(error)}`,
  };
  stopHeartbeat();
  publish();
  if (wasCapturing) {
    const shutdown = Promise.resolve(liveMeetingSTT?.stop()).then(
      () => {
        shutdownFailed = false;
      },
      () => {
        shutdownFailed = true;
      },
    );
    shutdownInFlight = shutdown;
    void shutdown.then(() => {
      if (shutdownInFlight === shutdown) shutdownInFlight = null;
    });
  }
  void enqueueWrite(() => setMeetingState(id, 'interrupted', active?.error ?? null)).catch(
    () => undefined,
  );
}

function onEvent(event: STTEvent) {
  if (!active || active.state !== 'active') return;
  if (event.kind === 'status') {
    if (event.state === 'failed') {
      const id = active.id;
      active = {
        ...active,
        state: 'interrupted',
        endedAt: Date.now(),
        error: event.message ?? 'Transcription stopped.',
      };
      stopHeartbeat();
      publish();
      void enqueueWrite(() =>
        setMeetingState(id, 'interrupted', event.message ?? 'Transcription stopped.'),
      ).catch((error) => failLocalSave(id, error));
      subscription?.remove();
      subscription = null;
    } else if (
      event.state === 'preparing' ||
      event.state === 'downloading' ||
      event.state === 'listening'
    ) {
      active = { ...active, captureStatus: event.state };
      publish();
    } else if (event.state === 'stopped' && !ending) {
      const id = active.id;
      active = {
        ...active,
        state: 'interrupted',
        endedAt: Date.now(),
        error: 'Capture stopped unexpectedly.',
      };
      stopHeartbeat();
      publish();
      void enqueueWrite(() =>
        setMeetingState(id, 'interrupted', 'Capture stopped unexpectedly.'),
      ).catch((error) => failLocalSave(id, error));
      subscription?.remove();
      subscription = null;
    }
    return;
  }
  transcript = applySTTEvent(transcript, event);
  const text = transcriptText(transcript);
  const id = active.id;
  active = { ...active, transcript: text };
  publish();
  const settled = enqueueWrite(() => saveTranscript(id, text)).catch((error) =>
    failLocalSave(id, error),
  );
  pendingSaveSettlements.add(settled);
  void settled.then(() => {
    pendingSaveSettlements.delete(settled);
  });
}

export function currentMeeting(): MeetingRecord | null {
  return active;
}

export function subscribeMeeting(listener: Listener): () => void {
  listeners.add(listener);
  listener(active);
  return () => listeners.delete(listener);
}

export function startMeeting(
  sessionId: string,
  engine: STTEngineId = 'fluid-nemotron',
): Promise<MeetingRecord> {
  if (startInFlight) {
    return startInFlight.then((meeting) => {
      if (meeting.sessionId !== sessionId)
        throw new Error('A meeting is already active in another session.');
      return meeting;
    });
  }
  const started = startMeetingUnlocked(sessionId, engine);
  startInFlight = started;
  const clear = () => {
    if (startInFlight === started) startInFlight = null;
  };
  void started.then(clear, clear);
  return started;
}

async function startMeetingUnlocked(
  sessionId: string,
  engine: STTEngineId,
): Promise<MeetingRecord> {
  await Promise.all([...pendingSaveSettlements]);
  if (shutdownInFlight) await shutdownInFlight;
  if (shutdownFailed) {
    await liveMeetingSTT?.stop();
    shutdownFailed = false;
  }
  if (active?.state === 'active') {
    if (active.sessionId !== sessionId)
      throw new Error('A meeting is already active in another session.');
    return active;
  }
  if (!liveMeetingSTT) throw new Error('Live meetings require the iOS native STT build.');
  const engines = await liveMeetingSTT.engines();
  if (!engines.some((candidate) => candidate.id === engine && candidate.available)) {
    throw new Error('The selected transcription engine is unavailable on this device.');
  }
  const meeting = await createMeeting(sessionId, engine);
  active = meeting;
  transcript = emptySTTTranscript;
  saveError = null;
  stopHeartbeat();
  subscription?.remove();
  subscription = liveMeetingSTT.addListener('onSTTEvent', onEvent);
  publish();
  try {
    await liveMeetingSTT.start(engine, 'de-DE', ['Verity']);
    heartbeat = setInterval(() => {
      if (active?.id !== meeting.id || active.state !== 'active') return;
      void enqueueWrite(() => touchMeeting(meeting.id)).catch((error) =>
        failLocalSave(meeting.id, error),
      );
    }, 5000);
  } catch (error) {
    active = { ...meeting, state: 'interrupted', endedAt: Date.now(), error: String(error) };
    subscription?.remove();
    subscription = null;
    publish();
    await enqueueWrite(() => setMeetingState(meeting.id, 'interrupted', String(error))).catch(
      () => undefined,
    );
    throw error;
  }
  return active;
}

export async function endMeeting(): Promise<void> {
  if (startInFlight) await startInFlight.catch(() => undefined);
  const meeting = active;
  if (!meeting || meeting.state !== 'active') return;
  ending = true;
  stopHeartbeat();
  let nativeStopCompleted = false;
  try {
    await liveMeetingSTT?.stop();
    nativeStopCompleted = true;
    await writeTail;
    await Promise.all([...pendingSaveSettlements]);
    if (saveError) throw saveError;
    await enqueueWrite(() => setMeetingState(meeting.id, 'ended'));
    active = { ...(active ?? meeting), state: 'ended', endedAt: Date.now() };
  } catch (error) {
    if (!nativeStopCompleted) shutdownFailed = true;
    const message = nativeStopCompleted ? `Local save failed: ${String(error)}` : String(error);
    active = {
      ...(active ?? meeting),
      state: 'interrupted',
      endedAt: Date.now(),
      error: message,
    };
    publish();
    await enqueueWrite(() => setMeetingState(meeting.id, 'interrupted', message)).catch(
      () => undefined,
    );
    throw error;
  } finally {
    ending = false;
    subscription?.remove();
    subscription = null;
    publish();
  }
}
