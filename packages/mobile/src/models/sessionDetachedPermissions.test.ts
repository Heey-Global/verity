import { expect, it, vi } from 'vitest';
import { sessionActivitySchema, type VerityClient } from '../api.js';
import { FakeTransport } from '../live/testing.js';
import { SessionModel } from './session.js';

const approval = {
  toolUseId: 'durable-secret',
  detached: true,
  tool: 'verity_http_request',
  riskClass: 'ask',
  input: { secretAlias: 'TEST_KEY', method: 'GET', url: 'https://api.example.com' },
  grantChannel: 'acp',
};
const pending = {
  pendingPermissions: [approval.toolUseId],
  pendingPermissionRequests: [approval],
};
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
function client() {
  return {
    getSession: vi.fn().mockResolvedValue({ resumable: true, status: 'idle' }),
    getActivity: vi.fn().mockResolvedValue({ busy: false, queued: [] }),
    getBoundedHistory: vi.fn().mockResolvedValue({
      contract: 'bounded-history-v1',
      kind: 'page',
      snapshotSeq: 30,
      beforeSeq: 30,
      events: [
        {
          seq: 30,
          event: {
            t: 'result',
            stopReason: 'end_turn',
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
            permissionDenials: [],
          },
        },
      ],
      hasMore: false,
    }),
    decidePermission: vi
      .fn()
      .mockResolvedValue({ sessionId: 's1', toolUseId: approval.toolUseId, decided: true }),
  };
}

it('reopens a completed session with its durable secret card from detail', async () => {
  const api = client();
  api.getSession.mockResolvedValue({ resumable: true, status: 'idle', ...pending });
  const transport = new FakeTransport();
  const model = new SessionModel({
    client: api as unknown as VerityClient,
    sessionId: 's1',
    transport,
  });
  try {
    model.start();
    await flush();
    transport.sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 30 }));
    expect(model.state.session.pendingPermission).toMatchObject({
      toolUseId: approval.toolUseId,
      input: approval.input,
      grantChannel: approval.grantChannel,
    });
    expect(model.state.session.running).toBe(false);
  } finally {
    model.stop();
  }
});

it('restores pending card contents from activity when the original event is outside history', async () => {
  const api = client();
  api.getActivity.mockResolvedValue({ busy: false, queued: [], ...pending });
  const transport = new FakeTransport();
  const model = new SessionModel({
    client: api as unknown as VerityClient,
    sessionId: 's1',
    transport,
  });
  try {
    model.start();
    await flush();
    transport.sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 30 }));
    expect(model.state.session.pendingPermission).toMatchObject({
      toolUseId: approval.toolUseId,
      input: approval.input,
      grantChannel: approval.grantChannel,
    });
    expect(model.state.session.running).toBe(false);
  } finally {
    model.stop();
  }
});

it('does not let a stale detail snapshot restore a card after its decision succeeds', async () => {
  const api = client();
  api.getSession.mockResolvedValue({ resumable: true, status: 'idle', ...pending });
  const transport = new FakeTransport();
  const model = new SessionModel({
    client: api as unknown as VerityClient,
    sessionId: 's1',
    transport,
  });
  try {
    model.start();
    await flush();
    transport.sockets[0]?.emitRaw(JSON.stringify({ k: 'caught_up', seq: 30 }));
    await model.decidePermission(approval.toolUseId, { behavior: 'allow' });
    model.refreshMetadata();
    await flush();
    expect(model.state.session.pendingPermission).toBeUndefined();
  } finally {
    model.stop();
  }
});

it('preserves detached card descriptors through activity response validation', () => {
  const activity = sessionActivitySchema.parse({ busy: false, queued: [], ...pending });
  expect(activity.pendingPermissionRequests).toEqual([approval]);
  expect(
    sessionActivitySchema.parse({
      busy: false,
      queued: [],
      pendingPermissionRequests: [{ tool: 'missing identity' }],
    }).pendingPermissionRequests,
  ).toBeUndefined();
});
