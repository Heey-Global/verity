import { describe, expect, it } from 'vitest';
import { VerityClient } from './api.js';
import { FakeTransport } from './live/testing.js';
import { mobileRuntimeSnapshot } from './runtimeDiagnostics.js';
import { SessionStream } from './stream.js';

describe('runtime diagnostic counters', () => {
  it('tracks logical subscriptions across reconnect, pause, end, and repeated cleanup', () => {
    const baseline = mobileRuntimeSnapshot();
    const transport = new FakeTransport();
    const stream = new SessionStream({ sessionId: 'private-id', transport });
    expect(mobileRuntimeSnapshot().sessionStreamsCreated).toBe(baseline.sessionStreamsCreated + 1);
    stream.start();
    stream.start();
    expect(mobileRuntimeSnapshot().activeSessionSubscriptions).toBe(
      baseline.activeSessionSubscriptions + 1,
    );
    transport.sockets[0]!.emitClose();
    transport.reconnect();
    expect(mobileRuntimeSnapshot().activeSessionSubscriptions).toBe(
      baseline.activeSessionSubscriptions + 1,
    );
    transport.sockets[1]!.emitEvent(1, { t: 'text', delta: 'private content' });
    transport.sockets[1]!.emitEvent(1, { t: 'text', delta: 'duplicate' });
    stream.seedHistory([{ seq: 0, event: { t: 'text', delta: 'history' } }]);
    expect(mobileRuntimeSnapshot().sessionEventsReceived).toBe(baseline.sessionEventsReceived + 2);
    expect(mobileRuntimeSnapshot().sessionEventsAccepted).toBe(baseline.sessionEventsAccepted + 1);
    stream.pause();
    stream.pause();
    expect(mobileRuntimeSnapshot().activeSessionSubscriptions).toBe(
      baseline.activeSessionSubscriptions,
    );
    stream.resume();
    expect(mobileRuntimeSnapshot().activeSessionSubscriptions).toBe(
      baseline.activeSessionSubscriptions + 1,
    );
    transport.sockets[2]!.emitRaw(JSON.stringify({ k: 'ended', reason: 'not_found' }));
    stream.stop();
    stream.stop();
    stream.resume();
    expect(mobileRuntimeSnapshot().activeSessionSubscriptions).toBe(
      baseline.activeSessionSubscriptions,
    );
    expect(mobileRuntimeSnapshot().sessionSubscriptionsStarted).toBe(
      baseline.sessionSubscriptionsStarted + 2,
    );
    const replacement = new SessionStream({ sessionId: 'other', transport });
    replacement.start();
    replacement.stop();
    replacement.stop();
    expect(mobileRuntimeSnapshot().activeSessionSubscriptions).toBe(
      baseline.activeSessionSubscriptions,
    );
    expect(Object.values(mobileRuntimeSnapshot()).every((value) => typeof value === 'number')).toBe(
      true,
    );
    // Previously exported samples must remain historical snapshots.
    expect(baseline.sessionEventsReceived).toBe(mobileRuntimeSnapshot().sessionEventsReceived - 2);
  });

  it('releases a failed subscription attempt and an unstarted stream has no active subscription', () => {
    const baseline = mobileRuntimeSnapshot();
    const stream = new SessionStream({
      sessionId: 's',
      transport: {
        subscribeSession: () => {
          throw new Error('failed');
        },
      },
    });
    expect(() => stream.start()).toThrow('failed');
    stream.stop();
    new SessionStream({ sessionId: 's', transport: new FakeTransport() }).stop();
    expect(mobileRuntimeSnapshot().activeSessionSubscriptions).toBe(
      baseline.activeSessionSubscriptions,
    );
  });

  it('settles concurrent API fetches on HTTP failure, success, abort, and synchronous failure', async () => {
    const baseline = mobileRuntimeSnapshot();
    const completions: ((response: Response) => void)[] = [];
    const client = new VerityClient({
      baseUrl: 'https://private.invalid',
      fetch: () => new Promise<Response>((resolve) => completions.push(resolve)),
    });
    const first = client.deleteTask('private-a');
    const second = client.deleteTask('private-b');
    expect(mobileRuntimeSnapshot().inFlightApiRequests).toBe(baseline.inFlightApiRequests + 2);
    completions[0]!(new Response(null, { status: 204 }));
    await first;
    expect(mobileRuntimeSnapshot().inFlightApiRequests).toBe(baseline.inFlightApiRequests + 1);
    completions[1]!(new Response('{}', { status: 500 }));
    await expect(second).rejects.toThrow();
    for (const error of [new DOMException('aborted', 'AbortError'), new Error('synchronous')]) {
      const failed = new VerityClient({
        baseUrl: 'https://private.invalid',
        fetch: () => {
          if (error.name === 'AbortError') return Promise.reject(error);
          throw error;
        },
      });
      await expect(failed.deleteTask('private')).rejects.toBe(error);
    }
    const result = mobileRuntimeSnapshot();
    expect(result.inFlightApiRequests).toBe(baseline.inFlightApiRequests);
    expect(result.apiRequestsStarted).toBe(baseline.apiRequestsStarted + 4);
    expect(result.apiRequestsSettled).toBe(baseline.apiRequestsSettled + 4);
    expect(result.apiRequestFailures).toBe(baseline.apiRequestFailures + 3);
  });
});
