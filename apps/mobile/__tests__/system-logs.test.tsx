import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());
import SystemLogsScreen from '../app/settings/system-logs';
import LogsScreen from '../app/settings/audit-logs/index';
import { BuildOutput } from '../components/logs/LogEntries';
import {
  makeClient,
  mockCreateVerityClient,
  mockReplace,
  resetSettingsHarness,
  refocus,
  setSearchParams,
} from './support/settingsHarness';
afterEach(() => resetSettingsHarness());
function logs(text: string, source: 'server' | 'host' = 'server') {
  return {
    source,
    state: 'available',
    window: {
      since: new Date(Date.now() - 3600000).toISOString(),
      until: new Date().toISOString(),
    },
    stale: false,
    truncated: false,
    entries: [{ at: new Date(Date.now() - 60000).toISOString(), level: null, text }],
  };
}
const emptyAudit = { events: [], nextBefore: null, oldestRecordedAt: null };
it('redirects legacy source and build links to the unified list or operation', () => {
  const rendered = render(<SystemLogsScreen />);
  expect(mockReplace).toHaveBeenLastCalledWith('/settings/audit-logs?category=system');
  rendered.unmount();
  setSearchParams({ operationId: 'build/1' });
  render(<SystemLogsScreen />);
  expect(mockReplace).toHaveBeenLastCalledWith('/settings/audit-logs/build%2F1');
});
it('keeps independent source results and explains server failure without hiding host entries', async () => {
  const systemLogs = jest.fn(({ source }) =>
    Promise.resolve(
      source === 'host'
        ? logs('runtime: runtime_error', 'host')
        : { ...logs(''), state: 'failed', reason: 'container_not_found', entries: [] },
    ),
  );
  mockCreateVerityClient.mockReturnValue(
    makeClient('unlocked', {
      systemLogs,
      auditEvents: jest.fn().mockResolvedValue(emptyAudit),
    }),
  );
  render(<LogsScreen />);
  expect(await screen.findByText('Container runtime error')).toBeOnTheScreen();
  expect(screen.getByText('Server logs unavailable')).toBeOnTheScreen();
  expect(screen.queryByText(/Host signals unavailable/)).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Details' }));
  expect(screen.getByText(/current server container could not be found/)).toBeOnTheScreen();
  fireEvent.press(screen.getAllByLabelText('Close', { exact: true })[0]!);
  expect(screen.queryByText('Audit')).toBeNull();
  fireEvent.press(screen.getByText('System'));
  expect(screen.getByText('Container runtime error')).toBeOnTheScreen();
});
it('ignores a stale source response after changing time windows', async () => {
  let resolveOld!: (value: ReturnType<typeof logs>) => void;
  const old = new Promise<ReturnType<typeof logs>>((resolve) => {
    resolveOld = resolve;
  });
  const systemLogs = jest
    .fn()
    .mockReturnValueOnce(old)
    .mockResolvedValueOnce(logs('initial host', 'host'))
    .mockResolvedValue(logs('fresh output'));
  mockCreateVerityClient.mockReturnValue(
    makeClient('unlocked', {
      systemLogs,
      auditEvents: jest.fn().mockResolvedValue(emptyAudit),
    }),
  );
  render(<LogsScreen />);
  await screen.findByText('Host event');
  fireEvent.press(screen.getByText('Last hour'));
  await screen.findAllByText('fresh output');
  await act(async () => resolveOld(logs('obsolete server output')));
  expect(screen.queryByText('obsolete server output')).toBeNull();
});
it('filters unknown severity honestly and searches loaded system messages', async () => {
  setSearchParams({ category: 'system' });
  const result = logs('unclassified');
  result.entries.push({
    ...result.entries[0]!,
    level: 'error' as never,
    text: '{"msg":"Compiler unavailable","level":50}',
  });
  mockCreateVerityClient.mockReturnValue(
    makeClient('unlocked', {
      systemLogs: jest.fn(({ source }) =>
        Promise.resolve(source === 'server' ? result : { ...logs('', 'host'), entries: [] }),
      ),
    }),
  );
  render(<LogsScreen />);
  expect(await screen.findByText('Compiler unavailable')).toBeOnTheScreen();
  fireEvent.press(screen.getByRole('tab', { name: 'Server' }));
  fireEvent.press(screen.getByText('Errors'));
  expect(screen.queryByText('unclassified')).toBeNull();
  expect(screen.getByText('Compiler unavailable')).toBeOnTheScreen();
  fireEvent.press(screen.getByText('All levels'));
  expect(screen.getByText('unclassified')).toBeOnTheScreen();
  fireEvent.changeText(screen.getByLabelText('Search logs'), 'not present');
  await waitFor(() => expect(screen.queryByText('Compiler unavailable')).toBeNull());
});
it('shows build output inline with explicit expiry and truncation', async () => {
  const buildDiagnostic = jest.fn().mockResolvedValueOnce({ state: 'expired', diagnostic: null });
  const client = makeClient('unlocked', { buildDiagnostic });
  const rendered = render(<BuildOutput client={client} operationId="build-1" status="failed" />);
  expect(await screen.findByText(/seven-day build diagnostic retention/)).toBeOnTheScreen();
  rendered.unmount();
  buildDiagnostic.mockResolvedValue({
    state: 'available',
    diagnostic: { recordedAt: new Date().toISOString(), text: 'compiler failed', truncated: true },
  });
  render(<BuildOutput client={client} operationId="build-2" status="failed" />);
  await screen.findByText(/Output shortened/);
  expect(screen.queryByText('compiler failed')).toBeNull();
  fireEvent.press(screen.getByText('Build output'));
  expect(screen.getByText('compiler failed')).toBeOnTheScreen();
  expect(buildDiagnostic).toHaveBeenLastCalledWith('build-2');
});

it('combines operations and system messages chronologically without waiting for every source', async () => {
  const recent = new Date(Date.now() - 60000).toISOString();
  const older = new Date(Date.now() - 120000).toISOString();
  const operation = {
    operationId: 'one',
    eventId: 'event-one',
    kind: 'build.succeeded',
    domain: 'builds',
    recordedAt: older,
    payload: {},
    project: null,
    initiator: { kind: 'unknown' },
    imageId: null,
    failedWrites: null,
  };
  const systemLogs = jest.fn(({ source }) =>
    source === 'host'
      ? new Promise(() => {})
      : Promise.resolve({
          ...logs('newest system message'),
          entries: [{ at: recent, text: 'newest system message', level: null }],
        }),
  );
  const auditEvents = jest.fn().mockResolvedValue({ ...emptyAudit, events: [operation] });
  mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { systemLogs, auditEvents }));
  render(<LogsScreen />);
  await screen.findByText('newest system message');
  expect(screen.getByText('Image build succeeded')).toBeOnTheScreen();
  const labels = screen
    .getAllByRole('button')
    .map((button) => button.props.accessibilityLabel as string);
  expect(labels.findIndex((label) => label?.startsWith('newest system message'))).toBeLessThan(
    labels.findIndex((label) => label?.startsWith('Image build succeeded')),
  );
  const window = auditEvents.mock.calls[0]![0];
  expect(systemLogs).toHaveBeenCalledWith(
    expect.objectContaining({ since: window.since, until: window.until }),
  );
});

it('keeps records without a timestamp separate from dated events and shows messages directly', async () => {
  const result = logs('dated message');
  result.entries.push({ at: null as never, level: null, text: 'undated message' });
  mockCreateVerityClient.mockReturnValue(
    makeClient('unlocked', {
      auditEvents: jest.fn().mockResolvedValue(emptyAudit),
      systemLogs: jest.fn(({ source }) =>
        Promise.resolve(source === 'server' ? result : { ...logs('', 'host'), entries: [] }),
      ),
    }),
  );
  render(<LogsScreen />);
  expect(await screen.findByText('undated message')).toBeOnTheScreen();
  // Once as the group header, once as the row's time.
  expect(screen.getAllByText('Time not recorded')).toHaveLength(2);
  const rows = screen.getAllByRole('button').map((row) => row.props.accessibilityLabel as string);
  expect(rows.findIndex((label) => label?.startsWith('dated message'))).toBeLessThan(
    rows.findIndex((label) => label?.startsWith('undated message')),
  );
  expect(
    screen.getByRole('button', { name: /undated message/ }).props.accessibilityState?.expanded,
  ).toBeUndefined();
});

it('shows no source status while every source is available and opens details from the header', async () => {
  mockCreateVerityClient.mockReturnValue(
    makeClient('unlocked', {
      systemLogs: jest.fn(({ source }) => Promise.resolve(logs('all good', source))),
      auditEvents: jest.fn().mockResolvedValue(emptyAudit),
    }),
  );
  render(<LogsScreen />);
  await screen.findAllByText('all good');
  expect(screen.queryByText(/unavailable/)).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Source details' }));
  expect(await screen.findByText(/Host entries are classified signals/)).toBeOnTheScreen();
});

it('re-reads the first page in place on return and hides system entries beyond unloaded audit pages', async () => {
  const at = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
  const auditEvent = {
    eventId: 'recent',
    operationId: 'op',
    kind: 'build.succeeded',
    domain: 'builds',
    recordedAt: at(10),
    project: null,
    imageId: null,
    payload: {},
  };
  const auditEvents = jest
    .fn()
    .mockResolvedValue({ events: [auditEvent], nextBefore: 'cursor', oldestRecordedAt: null });
  const systemLogs = jest.fn(({ source }) =>
    Promise.resolve(
      source === 'server'
        ? {
            ...logs('newer message'),
            entries: [
              { at: at(5), text: 'newer message', level: null },
              { at: at(30), text: 'older message', level: null },
            ],
          }
        : { ...logs('', 'host'), entries: [] },
    ),
  );
  mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { auditEvents, systemLogs }));
  render(<LogsScreen />);
  expect(await screen.findByText('newer message')).toBeOnTheScreen();
  expect(screen.queryByText('older message')).toBeNull();
  await act(async () => refocus());
  expect(auditEvents).toHaveBeenCalledTimes(2);
  expect(auditEvents.mock.calls[1]![0]).not.toHaveProperty('before');
  expect(screen.getByText('Image build succeeded')).toBeOnTheScreen();
  expect(screen.queryByText('Loading logs…')).toBeNull();
});

it.each(['stale', 'truncated'] as const)(
  'warns when an available source is %s',
  async (condition) => {
    const systemLogs = jest.fn(({ source }) =>
      Promise.resolve({
        ...logs(source === 'server' ? 'message' : 'host message', source),
        [condition]: source === 'server',
      }),
    );
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', { systemLogs, auditEvents: jest.fn().mockResolvedValue(emptyAudit) }),
    );
    render(<LogsScreen />);
    expect(await screen.findByText('Log history is incomplete')).toBeOnTheScreen();
    expect(screen.getByText('message')).toBeOnTheScreen();
  },
);
