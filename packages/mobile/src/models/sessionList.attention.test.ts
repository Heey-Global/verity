import { describe, expect, it, vi } from 'vitest';
import type { AttentionSignal, VerityClient } from '../api.js';
import { SessionListModel } from './sessionList.js';

const sealed: AttentionSignal = { code: 'secret_sealed', message: 'Server is sealed' };
const updater: AttentionSignal = { code: 'updater_unhealthy', message: 'Updater is not answering' };

function model(reads: Array<Promise<{ sessions: never[]; attention: AttentionSignal[] }>>) {
  const listSessionOverview = vi.fn(() => reads.shift()!);
  const client = {
    listSessions: vi.fn(async () => []),
    listSessionOverview,
  } as unknown as VerityClient;
  return new SessionListModel({ client });
}

describe('server.attention on Home', () => {
  // The notice above the list follows the server as it changes, not only on
  // the next list read.
  it('shows the signals an event announces, whole, and drops older ones', async () => {
    const list = model([Promise.resolve({ sessions: [], attention: [] })]);
    await list.refresh();
    expect(list.state.serverAttention).toBeNull();
    list.applyServerAttention([sealed], 2);
    expect(list.state.serverAttention).toMatchObject({ code: 'secret_sealed', count: 1 });
    // A late event of an older state must not bring the notice back or away.
    list.applyServerAttention([], 1);
    expect(list.state.serverAttention?.code).toBe('secret_sealed');
    list.applyServerAttention([], 3);
    expect(list.state.serverAttention).toBeNull();
  });

  // A list read out when the event arrives holds the signals as they were
  // before it; applied, it would show a notice the server already cleared.
  it('keeps the event when a list read that began before it answers', async () => {
    let answer: (value: { sessions: never[]; attention: AttentionSignal[] }) => void = () =>
      undefined;
    const list = model([
      new Promise((resolve) => (answer = resolve)),
      Promise.resolve({ sessions: [], attention: [updater] }),
    ]);
    const reading = list.refresh();
    list.applyServerAttention([], 1);
    answer({ sessions: [], attention: [sealed] });
    await reading;
    expect(list.state.serverAttention).toBeNull();
    // A read that began afterwards holds the newer state.
    await list.refresh();
    expect(list.state.serverAttention?.code).toBe('updater_unhealthy');
  });
});
