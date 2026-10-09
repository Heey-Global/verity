Object.defineProperty(globalThis, 'Response', { configurable: true, value: class TestResponse {} });
Object.defineProperty(globalThis, 'Headers', { configurable: true, value: class TestHeaders {} });
Object.defineProperty(globalThis, 'fetch', { configurable: true, value: jest.fn() });
const { acceptedDataDiagnostics, exportRemoteDataDiagnostics } =
  require('./remoteDataDiagnostics') as typeof import('./remoteDataDiagnostics');

const mockExport = jest.fn();
jest.mock('expo-modules-core', () => ({
  requireNativeModule: () => ({ exportDataDiagnostics: mockExport }),
}));

function snapshot() {
  return {
    version: 1,
    channel: 'DATA',
    generation: '01234567-0123-4123-8123-0123456789ab',
    sessionHash: 'c1448f52fd7bef90',
    clockOffsetKnown: false,
    startedLate: false,
    delegateAvailable: true,
    captureLimitMs: 120_000,
    expired: false,
    dropped: 0,
    events: [
      { sequence: 1, utc: '2026-10-08T15:23:11.100Z', elapsedMs: 0, event: 'capture_started' },
      {
        sequence: 2,
        utc: '2026-10-08T15:23:11.215Z',
        elapsedMs: 115,
        event: 'failure',
        cause: 'read_failure',
        errorDomain: 'NSURLErrorDomain',
        errorCode: -1005,
      },
    ],
  };
}

it('exports only bounded DATA generations with capture gaps intact', async () => {
  const data = { ...snapshot(), startedLate: true, delegateAvailable: false, dropped: 5 };
  mockExport.mockResolvedValue([JSON.stringify(data)]);
  expect(JSON.parse((await exportRemoteDataDiagnostics())!)).toEqual([data]);
});

it.each(['url', 'ticket', 'reason', 'headers', 'payload', 'userInfo'])(
  'rejects injected %s fields',
  (key) => {
    expect(acceptedDataDiagnostics(JSON.stringify({ ...snapshot(), [key]: 'private' }))).toBeNull();
    const data = snapshot();
    Object.assign(data.events[1]!, { [key]: 'private' });
    expect(acceptedDataDiagnostics(JSON.stringify(data))).toBeNull();
  },
);

it.each([
  { generation: 'raw-session-id' },
  { sessionHash: 'SESSION-secret' },
  { clockOffsetKnown: true },
  { channel: 'CONTROL' },
  { events: Array.from({ length: 129 }, () => snapshot().events[0]) },
])('rejects malformed envelopes %j', (patch) => {
  expect(acceptedDataDiagnostics(JSON.stringify({ ...snapshot(), ...patch }))).toBeNull();
});

it.each([
  { sequence: 1 },
  { elapsedMs: -1 },
  { elapsedMs: 120_001 },
  { cause: 'https://private' },
  { errorDomain: 'secret-domain' },
  { errorCode: 'https://private' },
  { event: 'private-reason' },
  { utc: 'not-a-date' },
  { path: 'private-network-name' },
])('rejects malformed events %j', (patch) => {
  const data = snapshot();
  Object.assign(data.events[1]!, patch);
  expect(acceptedDataDiagnostics(JSON.stringify(data))).toBeNull();
});

it('allows wall-clock reversal while preserving monotonic local ordering', () => {
  const data = snapshot();
  data.events[1]!.utc = '2026-10-08T15:23:10.000Z';
  expect(acceptedDataDiagnostics(JSON.stringify(data))).not.toBeNull();
});

it('rejects a partially unsafe export instead of silently dropping evidence', async () => {
  mockExport.mockResolvedValue([JSON.stringify(snapshot()), '{"ticket":"secret"}']);
  expect(await exportRemoteDataDiagnostics()).toBeNull();
});

it('does not accept oversized exports or unrestricted native text', async () => {
  expect(acceptedDataDiagnostics(' '.repeat(65_537))).toBeNull();
  mockExport.mockResolvedValue('private native log');
  expect(await exportRemoteDataDiagnostics()).toBeNull();
});
