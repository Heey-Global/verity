import { readFileSync } from 'node:fs';
import { join } from 'node:path';

jest.mock('expo-crypto', () => ({
  getRandomBytes: (count: number) => new Uint8Array(count).fill(7),
}));

import { requestTeamJoinAdmission, TeamJoinAdmissionError } from './teamJoinAdmission';

// Frames as the contract defines them; the app's request id replaces the fixture's.
const fixtures = JSON.parse(
  readFileSync(
    join(__dirname, '../../../scripts/team-bootstrap-contract/wire-fixtures.json'),
    'utf8',
  ),
) as Array<{ schema: string; valid: boolean; value: Record<string, unknown> }>;
const valid = (schema: string) =>
  fixtures.find((fixture) => fixture.valid && fixture.schema === schema)!.value;

class FakeSocket {
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, event: { data?: unknown } = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const start = () => {
  let socket!: FakeSocket;
  const admission = requestTeamJoinAdmission({
    uplinkOrigin: 'https://uplink.verity.build',
    installationHandle: 'AQEBAQEBAQEBAQEBAQEBAQ',
    invitationId: 'MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM',
    socketFactory: (url) => {
      socket = new FakeSocket(url);
      return socket as unknown as WebSocket;
    },
  });
  socket.emit('open');
  const request = JSON.parse(socket.sent[0]!) as Record<string, unknown>;
  return { admission, socket, request };
};

it('sends the one reserve request and resolves with the ticket and Uplink’s redemption', async () => {
  const { admission, socket, request } = start();
  expect(socket.url).toBe('wss://uplink.verity.build/remote-control');
  expect(Object.keys(request).sort()).toEqual(Object.keys(valid('joinReserve')).sort());
  expect(request).toMatchObject({ type: 'team.join.reserve', capabilities: ['team-bootstrap-v1'] });
  socket.emit('message', {
    data: JSON.stringify({ ...valid('joinReady'), requestId: request.requestId }),
  });
  await expect(admission).resolves.toMatchObject({
    sessionId: valid('joinReady').sessionId,
    redemptionId: valid('joinReady').redemptionId,
    ticket: valid('joinReady').ticket,
  });
});

it('reports Uplink’s refusal with its code', async () => {
  const { admission, socket, request } = start();
  socket.emit('message', {
    data: JSON.stringify({
      type: 'team.join.error',
      requestId: request.requestId,
      code: 'unavailable',
    }),
  });
  await expect(admission).rejects.toEqual(new TeamJoinAdmissionError('unavailable'));
  expect(socket.closed).toBe(true);
});

it('accepts no ready frame for another request or with extra fields', async () => {
  const other = start();
  other.socket.emit('message', {
    data: JSON.stringify({ ...valid('joinReady'), requestId: 'someone_else' }),
  });
  await expect(other.admission).rejects.toThrow('Invalid team join admission response.');
  const extra = start();
  extra.socket.emit('message', {
    data: JSON.stringify({
      ...valid('joinReady'),
      requestId: extra.request.requestId,
      coreOrigin: 'https://evil.example',
    }),
  });
  await expect(extra.admission).rejects.toThrow('Invalid team join admission response.');
});
