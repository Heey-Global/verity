import {
  replayMeetingJournal,
  type MeetingJournalEnvelope,
  type MeetingJournalReader,
} from './liveMeetingJournal';

function envelope(sequence: number, meetingId = 'meeting-1'): MeetingJournalEnvelope {
  return {
    meetingId,
    sequence,
    event: { kind: 'snapshot', text: `words ${sequence}`, final: false },
  };
}

function reader(events: MeetingJournalEnvelope[]): MeetingJournalReader {
  return {
    read: jest.fn(async (_meetingId: string, after: number, limit: number) =>
      events.filter((event) => event.sequence > after).slice(0, limit),
    ),
    acknowledge: jest.fn(async () => undefined),
  };
}

describe('native meeting journal replay', () => {
  it('waits for durable writes before acknowledging and bounds each drain', async () => {
    const native = reader([envelope(1), envelope(2), envelope(3)]);
    const order: string[] = [];
    native.acknowledge = jest.fn(async (_id, sequence) => {
      order.push(`ack ${sequence}`);
    });
    const result = await replayMeetingJournal(
      native,
      'meeting-1',
      async ({ sequence }) => {
        order.push(`save ${sequence}`);
      },
      { batchSize: 2, maxBatches: 1 },
    );
    expect(order).toEqual(['save 1', 'save 2', 'ack 2']);
    expect(result).toEqual({ applied: 2, hasMore: true });
    expect(native.read).toHaveBeenCalledTimes(1);
  });

  it('retains a partially saved batch and safely replays after a crash', async () => {
    const native = reader([envelope(1), envelope(2)]);
    const durable = new Map<number, string>();
    let fail = true;
    const save = async (event: MeetingJournalEnvelope) => {
      if (event.sequence === 2 && fail) throw new Error('disk unavailable');
      // Models a transaction that applies the event and cursor together.
      durable.set(event.sequence, event.event.kind);
    };
    await expect(replayMeetingJournal(native, 'meeting-1', save)).rejects.toThrow(
      'disk unavailable',
    );
    expect(native.acknowledge).not.toHaveBeenCalled();
    expect([...durable.keys()]).toEqual([1]);
    fail = false;
    await replayMeetingJournal(native, 'meeting-1', save);
    expect([...durable.keys()]).toEqual([1, 2]);
    expect(native.acknowledge).toHaveBeenCalledWith('meeting-1', 2);
  });

  it('keeps persisted results replayable when the native acknowledgement fails', async () => {
    const native = reader([envelope(1)]);
    native.acknowledge = jest.fn(async () => {
      throw new Error('protected data unavailable');
    });
    const persist = jest.fn(async () => undefined);
    await expect(replayMeetingJournal(native, 'meeting-1', persist)).rejects.toThrow(
      'protected data unavailable',
    );
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it.each([
    [envelope(1, 'other-meeting')],
    [envelope(2), envelope(1)],
    [envelope(1), envelope(1)],
    [envelope(0)],
  ])(
    'rejects mixed meeting identities or non-monotonic sequence batches: %j',
    async (...events) => {
      const native: MeetingJournalReader = {
        read: jest.fn(async () => events),
        acknowledge: jest.fn(async () => undefined),
      };
      await expect(
        replayMeetingJournal(native, 'meeting-1', async () => undefined),
      ).rejects.toThrow('Invalid meeting journal event order');
      expect(native.acknowledge).not.toHaveBeenCalled();
    },
  );
});
