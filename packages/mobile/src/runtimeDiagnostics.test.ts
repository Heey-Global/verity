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
    expect(
      Object.values(mobileRuntimeSnapshot())
        .filter((value) => typeof value !== 'object')
        .every((value) => typeof value === 'number'),
    ).toBe(true);
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

it('classifies requests into fixed content-free groups and snapshots interval peaks', async () => {
  const { runtimeRequestGroup, beginRuntimeApiRequest } = await import('./runtimeDiagnostics.js');
  expect(runtimeRequestGroup('/projects?private=query', 'GET')).toBe('overview');
  expect(runtimeRequestGroup('/sessions/private-id/events?before=123', 'GET')).toBe('session');
  expect(runtimeRequestGroup('/sessions/private-id/activity', 'GET')).toBe('session');
  expect(runtimeRequestGroup('/sessions/private-id', 'GET')).toBe('session');
  expect(runtimeRequestGroup('/projects/private-id/public-shares', 'GET')).toBe('preview');
  expect(runtimeRequestGroup('/projects/private-id/local-shares', 'GET')).toBe('preview');
  expect(runtimeRequestGroup('/sessions/private-id/dev-servers', 'GET')).toBe('preview');
  expect(runtimeRequestGroup('/sessions/private-id/managed-dev-servers', 'GET')).toBe('preview');
  expect(runtimeRequestGroup('/sessions/private-id/seen', 'PATCH')).toBe('other');
  expect(runtimeRequestGroup('/projects/private-id/public-shares', 'POST')).toBe('other');
  expect(runtimeRequestGroup('/projects/private-id/settings', 'GET')).toBe('other');
  const baseline = mobileRuntimeSnapshot(true);
  const first = beginRuntimeApiRequest('preview');
  const second = beginRuntimeApiRequest('preview');
  first(false);
  first(true);
  second(true);
  const sample = mobileRuntimeSnapshot(true);
  expect(sample.apiRequestGroups.preview).toEqual({
    started: baseline.apiRequestGroups.preview.started + 2,
    settled: baseline.apiRequestGroups.preview.settled + 2,
    failures: baseline.apiRequestGroups.preview.failures + 1,
    inFlight: baseline.apiRequestGroups.preview.inFlight,
    peakInFlight: baseline.apiRequestGroups.preview.inFlight + 2,
  });
  expect(mobileRuntimeSnapshot().apiRequestGroups.preview.peakInFlight).toBe(
    baseline.apiRequestGroups.preview.inFlight,
  );
  expect(sample.apiRequestGroups.preview.peakInFlight).toBe(
    baseline.apiRequestGroups.preview.inFlight + 2,
  );
  expect(Object.keys(sample.apiRequestGroups)).toEqual(['overview', 'preview', 'session', 'other']);
  expect(JSON.stringify(sample)).not.toContain('private');
});

it('attributes actual API reads and their failures to their group', async () => {
  const baseline = mobileRuntimeSnapshot();
  const client = new VerityClient({
    baseUrl: 'https://private.invalid',
    fetch: async () => new Response('{}', { status: 500 }),
  });
  await expect(client.listPublicPreviewShares('private')).rejects.toThrow();
  await expect(client.listManagedDevServers('private')).rejects.toThrow();
  const sample = mobileRuntimeSnapshot();
  expect(sample.apiRequestGroups.preview.started).toBe(
    baseline.apiRequestGroups.preview.started + 2,
  );
  expect(sample.apiRequestGroups.preview.failures).toBe(
    baseline.apiRequestGroups.preview.failures + 2,
  );
  expect(sample.apiRequestGroups.preview.inFlight).toBe(baseline.apiRequestGroups.preview.inFlight);
});
