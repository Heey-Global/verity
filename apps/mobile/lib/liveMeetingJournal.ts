import type { STTEvent } from './liveMeetingSTT';

export interface MeetingJournalEnvelope {
  meetingId: string;
  sequence: number;
  event: STTEvent;
}

export interface MeetingJournalReader {
  read(meetingId: string, after: number, limit: number): Promise<MeetingJournalEnvelope[]>;
  acknowledge(meetingId: string, through: number): Promise<void>;
}

/** The sink must commit the event and its sequence in the same SQLite transaction. */
export async function replayMeetingJournal(
  native: MeetingJournalReader,
  meetingId: string,
  persist: (envelope: MeetingJournalEnvelope) => Promise<void>,
  options: { batchSize?: number; maxBatches?: number } = {},
): Promise<{ applied: number; hasMore: boolean }> {
  const batchSize = Math.max(1, Math.min(128, options.batchSize ?? 64));
  const maxBatches = Math.max(1, Math.min(128, options.maxBatches ?? 8));
  let applied = 0;
  let after = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const events = await native.read(meetingId, after, batchSize);
    if (!events.length) return { applied, hasMore: false };
    for (const envelope of events) {
      // A mixed meeting or reordered batch must never acknowledge another recording's data.
      if (
        envelope.meetingId !== meetingId ||
        !Number.isSafeInteger(envelope.sequence) ||
        envelope.sequence <= after
      )
        throw new Error('Invalid meeting journal event order.');
      await persist(envelope);
      after = envelope.sequence;
      applied += 1;
    }
    // If applying any event failed, retain the entire batch. The sink's durable cursor makes retry safe.
    await native.acknowledge(meetingId, after);
    if (events.length < batchSize) return { applied, hasMore: false };
  }
  return { applied, hasMore: true };
}
