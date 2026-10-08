import { createWatchInboxDrainer, type WatchCapture } from './watchCapture';

jest.mock('./tasksStore', () => ({ captureTask: jest.fn() }));

const capture = (id: string): WatchCapture => ({
  id,
  text: `note ${id}`,
  createdAt: '2026-10-08T10:00:00Z',
  durationMs: 1200,
});

function inbox(initial: WatchCapture[]) {
  const entries = [...initial];
  return {
    entries,
    pending: jest.fn(async () => [...entries]),
    acknowledge: jest.fn(async (id: string) => {
      entries.splice(
        entries.findIndex((entry) => entry.id === id),
        1,
      );
    }),
  };
}

describe('watch inbox drain', () => {
  it('saves each capture before releasing it from the inbox', async () => {
    const box = inbox([capture('a'), capture('b')]);
    const order: string[] = [];
    const save = jest.fn(async (c: WatchCapture) => void order.push(`save ${c.id}`));
    box.acknowledge.mockImplementation(async (id: string) => {
      order.push(`ack ${id}`);
      box.entries.splice(
        box.entries.findIndex((entry) => entry.id === id),
        1,
      );
    });
    await createWatchInboxDrainer(box, save)();
    expect(order).toEqual(['save a', 'ack a', 'save b', 'ack b']);
    expect(box.entries).toHaveLength(0);
  });

  // The silent failure: acknowledging a capture the queue never stored deletes
  // the only copy of the recording on the iPhone.
  it('keeps a capture in the inbox when saving fails', async () => {
    const box = inbox([capture('a')]);
    const save = jest.fn(async () => {
      throw new Error('Sign in to save tasks');
    });
    await expect(createWatchInboxDrainer(box, save)()).rejects.toThrow('Sign in');
    expect(box.acknowledge).not.toHaveBeenCalled();
    expect(box.entries).toHaveLength(1);
  });

  it('runs another pass for a capture that lands mid-drain', async () => {
    const box = inbox([capture('a')]);
    let drain: () => Promise<void> = async () => undefined;
    const save = jest.fn(async (c: WatchCapture) => {
      if (c.id === 'a') {
        box.entries.push(capture('b'));
        void drain();
      }
    });
    drain = createWatchInboxDrainer(box, save);
    await drain();
    expect(save.mock.calls.map(([c]) => c.id)).toEqual(['a', 'b']);
    expect(box.entries).toHaveLength(0);
  });
});
