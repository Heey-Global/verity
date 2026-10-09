import type { LiveSocket } from '@verity/mobile';
import { beginSessionSwitch, sessionSwitchTiming } from '@verity/mobile';
import { rowPress } from './sessionSwitchTiming';
import { measureSocketActivity } from './socket';

jest.mock('./pinnedTransport', () => ({ createPinnedWebSocket: jest.fn() }));
jest.mock('./serverProfile', () => ({ getServerProfile: jest.fn() }));
jest.mock('./demoTransport', () => ({ createDemoSocket: jest.fn(), isDemoUrl: () => false }));

it('measures listener work even when it throws and preserves socket arguments', () => {
  let clock = 0;
  const spy = jest.spyOn(performance, 'now').mockImplementation(() => clock);
  try {
    beginSessionSwitch('previous');
    rowPress('socket');
    let callback: ((event: { data?: unknown; code?: number }) => void) | undefined;
    const raw: LiveSocket = {
      addEventListener: (_type, listener) => {
        callback = listener;
      },
      send: jest.fn(),
      close: jest.fn(),
    };
    const measured = measureSocketActivity(raw);
    const event = { data: 'private payload' };
    measured.addEventListener('message', (received) => {
      expect(received).toBe(event);
      clock += 450;
      throw new Error('listener failure');
    });
    expect(() => callback!(event)).toThrow('listener failure');
    const phases = sessionSwitchTiming('socket')!.phases;
    expect(phases.find((p) => p.phase === 'activity-socket-message-total-ms')?.value).toBe(450);
    expect(JSON.stringify(phases)).not.toContain('private payload');
    measured.send('outgoing');
    measured.close(1000, 'finished');
    expect(raw.send).toHaveBeenCalledWith('outgoing');
    expect(raw.close).toHaveBeenCalledWith(1000, 'finished');
  } finally {
    spy.mockRestore();
  }
});
