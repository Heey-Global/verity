import { fireEvent, render as renderScreen, screen, waitFor } from '@testing-library/react-native';

jest.mock('./ConnectionRecording', () => ({
  ConnectionRecording: () => {
    const { Text } = require('react-native');
    return <Text>Unified recording</Text>;
  },
}));

const mockTestRemoteControl = jest.fn();
const mockGetServerProfile = jest.fn();
const mockExportData = jest.fn();
const mockCopy = jest.fn();
const mockRecordingRemaining = jest.fn().mockResolvedValue(0);
const mockStopRecording = jest.fn().mockResolvedValue(true);
jest.mock('../../lib/remoteDataDiagnostics', () => ({
  exportRemoteDataDiagnostics: () => mockExportData(),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: (...args: unknown[]) => mockCopy(...args) }));

// The screen loads its status on focus; run that effect once on mount.
jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void) => require('react').useEffect(effect, [effect]),
}));
jest.mock('../../lib/serverProfile', () => ({
  getServerProfile: () => mockGetServerProfile(),
}));
jest.mock('../../lib/remoteControlTransport', () => ({
  testRemoteControlForUrl: (...args: unknown[]) => mockTestRemoteControl(...args),
  remoteDataRecordingRemainingMs: () => mockRecordingRemaining(),
  stopRemoteDataRecording: () => mockStopRecording(),
  remoteControlFailureForUrl: jest.fn(() => null),
}));

import { PublicPreviewDiagnostics } from './PublicPreviewDiagnostics';
import type { ReactElement } from 'react';
import { Text } from 'react-native';

function render(element: ReactElement) {
  const result = renderScreen(element);
  fireEvent.press(screen.getByText('Advanced diagnostics'));
  return result;
}

it('finishes the tunnel test while the separate Core status refresh is pending', async () => {
  mockGetServerProfile.mockReturnValue({
    activeUrl: 'https://verity.example',
    remoteControl: { installationHandle: 'saved' },
  });
  mockTestRemoteControl.mockResolvedValue({ ready: false, detail: 'probe timed out' });
  const getUplinkDiagnostics = jest.fn(() => new Promise<never>(() => undefined));

  render(<PublicPreviewDiagnostics client={{ getUplinkDiagnostics } as never} keyConfigured />);
  fireEvent.press(screen.getByRole('button', { name: 'Test Remote access through Uplink' }));

  await waitFor(() => {
    expect(screen.getByText('Remote access failed at probe timed out.')).toBeOnTheScreen();
    expect(screen.getByText('Test remote access')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Test Remote access through Uplink' })).toBeEnabled();
  });
  // One load on open, one after the test — neither may hold the test open.
  expect(getUplinkDiagnostics).toHaveBeenCalledTimes(2);
});

it("shows Core's side of each tunnel stream beside the phone test result", async () => {
  mockGetServerProfile.mockReturnValue({
    activeUrl: 'https://verity.example',
    remoteControl: { installationHandle: 'saved' },
  });
  const getUplinkDiagnostics = jest.fn().mockResolvedValue({
    control: 'connected',
    sharing: 'ready',
    remoteControl: 'ready',
    remoteStreams: [
      {
        sessionId: 'session_one',
        streamId: 'abcdef01',
        startedAt: 1,
        durationMs: 31_052,
        firstLocalReplyMs: 53,
        receivedFromAppBytes: 1_911,
        writtenToLocalBytes: 1_911,
        receivedFromLocalBytes: 3_080,
        sentToUplinkBytes: 3_080,
        framesFromApp: 2,
        framesToApp: 3,
        state: 'open',
      },
      {
        sessionId: 'session_one',
        streamId: 'abcdef02',
        startedAt: 1,
        durationMs: 30_813,
        firstLocalReplyMs: null,
        receivedFromAppBytes: 1_529,
        writtenToLocalBytes: 1_529,
        receivedFromLocalBytes: 0,
        sentToUplinkBytes: 0,
        state: 'open',
      },
    ],
  });

  render(<PublicPreviewDiagnostics client={{ getUplinkDiagnostics } as never} keyConfigured />);
  // Without Core's view a request the ingress swallowed is indistinguishable
  // from one Uplink never delivered.
  await waitFor(() =>
    expect(
      screen.getByText(
        /abcdef01: from phone 1911 B, to Core 1911 B, Core answered after 53 ms, from Core 3080 B, accepted by Core transport 3080 B in 3 attempted frames \(2 from phone\), open, 31\.1 s/u,
      ),
    ).toBeOnTheScreen(),
  );
  // A Core without frame counts renders the line as before.
  expect(
    screen.getByText(
      /abcdef02: .*Core never answered, from Core 0 B, accepted by Core transport 0 B, open, 30\.8 s/u,
    ),
  ).toBeOnTheScreen();
});

it('offers the tunnel test when Core settings and status are unavailable', async () => {
  mockGetServerProfile.mockReturnValue({
    activeUrl: 'https://verity.example',
    remoteControl: { installationHandle: 'saved' },
  });
  mockTestRemoteControl.mockResolvedValue({ ready: false, detail: 'probe timed out' });
  const getUplinkDiagnostics = jest.fn().mockRejectedValue(new Error('offline'));

  render(
    <PublicPreviewDiagnostics
      client={{ getUplinkDiagnostics } as never}
      keyConfigured={undefined}
    />,
  );
  await waitFor(() => expect(screen.getByText(/Core did not answer/u)).toBeOnTheScreen());
  fireEvent.press(screen.getByRole('button', { name: 'Test Remote access through Uplink' }));
  await waitFor(() =>
    expect(screen.getByText('Remote access failed at probe timed out.')).toBeOnTheScreen(),
  );
});

it('records only the explicitly selected connection test and copies the safe native export', async () => {
  mockGetServerProfile.mockReturnValue({
    activeUrl: 'https://verity.example',
    remoteControl: { installationHandle: 'saved' },
  });
  mockTestRemoteControl.mockClear().mockResolvedValue({ ready: true, detail: 'ready' });
  mockExportData.mockResolvedValue({ status: 'ready', recording: '[{"version":1}]' });
  mockCopy.mockResolvedValue(undefined);
  render(
    <PublicPreviewDiagnostics
      client={{ getUplinkDiagnostics: jest.fn().mockResolvedValue(null) } as never}
      keyConfigured
    />,
  );
  fireEvent.press(screen.getByRole('button', { name: 'Record Remote access connection test' }));
  await waitFor(() =>
    expect(mockTestRemoteControl).toHaveBeenCalledWith('https://verity.example', true),
  );
  fireEvent.press(screen.getByLabelText('Copy connection recording'));
  await waitFor(() => expect(mockCopy).toHaveBeenCalledWith('[{"version":1}]'));
  expect(screen.getByText('Connection recording copied.')).toBeOnTheScreen();
});

it('does not copy when a safe recording is unavailable', async () => {
  mockGetServerProfile.mockReturnValue({
    activeUrl: 'https://verity.example',
    remoteControl: { installationHandle: 'saved' },
  });
  mockExportData.mockResolvedValue({ status: 'empty' });
  mockCopy.mockClear();
  render(
    <PublicPreviewDiagnostics
      client={{ getUplinkDiagnostics: jest.fn().mockResolvedValue(null) } as never}
      keyConfigured
    />,
  );
  fireEvent.press(screen.getByLabelText('Copy connection recording'));
  await waitFor(() =>
    expect(screen.getByText(/No connection recording was retained/u)).toBeOnTheScreen(),
  );
  expect(mockCopy).not.toHaveBeenCalled();
});

it('copies retained stream diagnostics after leaving and reopening settings without rerunning the test', async () => {
  mockGetServerProfile.mockReturnValue({
    activeUrl: 'https://verity.example',
    remoteControl: { installationHandle: 'saved' },
  });
  mockTestRemoteControl.mockClear().mockResolvedValue({ ready: false, detail: 'probe timed out' });
  const retained = '[{"version":1,"streams":[{"streamId":"0123456789ABCDEF0123456789ABCDEF"}]}]';
  mockExportData.mockResolvedValue({ status: 'ready', recording: retained });
  mockCopy.mockClear().mockResolvedValue(undefined);
  const client = { getUplinkDiagnostics: jest.fn().mockResolvedValue(null) } as never;
  const first = render(<PublicPreviewDiagnostics client={client} keyConfigured />);
  fireEvent.press(screen.getByRole('button', { name: 'Record Remote access connection test' }));
  await waitFor(() =>
    expect(screen.getByText('Remote access failed at probe timed out.')).toBeOnTheScreen(),
  );
  first.unmount();
  render(<PublicPreviewDiagnostics client={client} keyConfigured />);
  expect(screen.queryByText('Remote access failed at probe timed out.')).toBeNull();
  fireEvent.press(screen.getByLabelText('Copy connection recording'));
  await waitFor(() => expect(mockCopy).toHaveBeenCalledWith(retained));
  expect(mockTestRemoteControl).toHaveBeenCalledTimes(1);
});

it.each([
  ['unsupported', 'This app build does not support connection recording export.'],
  ['invalid', 'The recording could not be copied because its format failed validation.'],
  ['failed', 'The app could not read the connection recording.'],
])('reports %s export failures without copying rejected data', async (status, message) => {
  mockGetServerProfile.mockReturnValue({ activeUrl: 'https://verity.example', remoteControl: {} });
  mockExportData.mockResolvedValue({ status });
  mockCopy.mockClear();
  render(
    <PublicPreviewDiagnostics
      client={{ getUplinkDiagnostics: jest.fn().mockResolvedValue(null) } as never}
      keyConfigured
    />,
  );
  fireEvent.press(screen.getByLabelText('Copy connection recording'));
  await waitFor(() => expect(screen.getByText(message)).toBeOnTheScreen());
  expect(mockCopy).not.toHaveBeenCalled();
});

it('distinguishes a local switch from an entitlement the subscription does not include', async () => {
  mockGetServerProfile.mockReturnValue(null);
  const getUplinkDiagnostics = jest.fn().mockResolvedValue({
    control: 'connected',
    sharing: 'unavailable',
    remoteControl: 'unavailable',
    features: {
      sharing: { granted: true, enabled: false, effective: false },
      remoteAccess: { granted: false, enabled: true, effective: false },
    },
  });
  render(<PublicPreviewDiagnostics client={{ getUplinkDiagnostics } as never} keyConfigured />);
  expect(await screen.findByText('Switched off in Verity Premium')).toBeOnTheScreen();
  expect(screen.getByText('Not included in your subscription')).toBeOnTheScreen();
});

it('shows idle sharing and explicitly checks rights without implying a reconnect loop', async () => {
  mockGetServerProfile.mockReturnValue(null);
  const getUplinkDiagnostics = jest.fn().mockResolvedValue({
    control: 'idle',
    entitlement: 'unchecked',
    sharing: 'unavailable',
    remoteControl: 'unavailable',
    features: {
      sharing: { enabled: true, granted: false, effective: false },
      remoteAccess: { enabled: false, granted: false, effective: false },
    },
  });
  const checkUplinkEntitlements = jest.fn().mockResolvedValue({
    control: 'idle',
    entitlement: 'checked',
    sharing: 'unavailable',
    remoteControl: 'unavailable',
    features: {
      sharing: { enabled: true, granted: true, effective: false },
      remoteAccess: { enabled: false, granted: false, effective: false },
    },
  });
  render(
    <PublicPreviewDiagnostics
      client={{ getUplinkDiagnostics, checkUplinkEntitlements } as never}
      keyConfigured
    />,
  );
  await waitFor(() =>
    expect(screen.getByText('Rights are checked when a feature is first used')).toBeOnTheScreen(),
  );
  expect(screen.getByText('Idle')).toBeOnTheScreen();
  expect(screen.getByText('Not checked')).toBeOnTheScreen();
  fireEvent.press(screen.getByLabelText(/^Check subscription rights(,|$)/));
  await waitFor(() => expect(screen.getAllByText('On demand')).toHaveLength(2));
  expect(screen.getByText('Connects when a feature is in use')).toBeOnTheScreen();
  expect(checkUplinkEntitlements).toHaveBeenCalledTimes(1);
  expect(getUplinkDiagnostics).toHaveBeenCalledTimes(1);
});

it('never reports Remote access as on demand while the channel idles', async () => {
  // Only sharing dials Uplink on demand. An idle channel with Remote access
  // granted means it is not reachable, and a green dot would hide that.
  mockGetServerProfile.mockReturnValue(null);
  const getUplinkDiagnostics = jest.fn().mockResolvedValue({
    control: 'idle',
    entitlement: 'checked',
    sharing: 'unavailable',
    remoteControl: 'unavailable',
    features: {
      sharing: { enabled: true, granted: true, effective: false },
      remoteAccess: { enabled: true, granted: true, effective: false },
    },
  });
  render(<PublicPreviewDiagnostics client={{ getUplinkDiagnostics } as never} keyConfigured />);
  // One for the Uplink channel itself, one for Online sharing — none for Remote access.
  await waitFor(() => expect(screen.getAllByText('On demand')).toHaveLength(2));
  expect(screen.getByText('–')).toBeOnTheScreen();
});

it('offers a retry when the status could not be loaded', async () => {
  // Without a saved route every other row is inert; leaving the screen must not
  // be the only way to try again.
  mockGetServerProfile.mockReturnValue(null);
  const getUplinkDiagnostics = jest
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ control: 'connected', sharing: 'ready', remoteControl: 'ready' });
  render(<PublicPreviewDiagnostics client={{ getUplinkDiagnostics } as never} keyConfigured />);
  fireEvent.press(await screen.findByLabelText(/^Try again(,|$)/));
  await waitFor(() => expect(screen.getByText('Connected')).toBeOnTheScreen());
  expect(screen.queryByLabelText(/^Try again(,|$)/)).toBeNull();
});
// Route loss is precisely when the retained local evidence must remain accessible.
it.each([null, { activeUrl: 'https://verity.example' }])(
  'exports locally without a saved route or reachable Core (%s)',
  async (profile) => {
    mockGetServerProfile.mockReturnValue(profile);
    mockExportData.mockResolvedValue({ status: 'ready', recording: '[{"version":1}]' });
    mockCopy.mockClear().mockResolvedValue(undefined);
    const getUplinkDiagnostics = jest.fn().mockRejectedValue(new Error('offline'));
    render(<PublicPreviewDiagnostics client={{ getUplinkDiagnostics } as never} keyConfigured />);
    fireEvent.press(screen.getByLabelText('Copy connection recording'));
    await waitFor(() => expect(mockCopy).toHaveBeenCalledWith('[{"version":1}]'));
    expect(getUplinkDiagnostics).toHaveBeenCalledTimes(1);
  },
);

it('only reads recording status on mount and stops locally while a probe and Core are pending', async () => {
  mockGetServerProfile.mockReturnValue({ activeUrl: 'https://verity.example', remoteControl: {} });
  mockRecordingRemaining.mockResolvedValue(60_000);
  mockTestRemoteControl.mockClear().mockReturnValue(new Promise(() => undefined));
  mockStopRecording.mockClear().mockResolvedValue(true);
  const client = { getUplinkDiagnostics: jest.fn(() => new Promise(() => undefined)) } as never;
  render(<PublicPreviewDiagnostics client={client} keyConfigured />);
  await screen.findByText('Recording · 60 seconds remaining');
  expect(mockTestRemoteControl).not.toHaveBeenCalled();
  expect(mockStopRecording).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText('Test Remote access through Uplink'));
  fireEvent.press(screen.getByText('Stop local recording'));
  await screen.findByText('Not recording');
  expect(mockStopRecording).toHaveBeenCalledTimes(1);
  expect(mockTestRemoteControl).toHaveBeenCalledTimes(1);
});

it('keeps local stop available without a profile and reports a failed stop honestly', async () => {
  mockGetServerProfile.mockReturnValue(null);
  mockStopRecording.mockClear().mockResolvedValue(false);
  render(
    <PublicPreviewDiagnostics
      client={{ getUplinkDiagnostics: jest.fn().mockRejectedValue(new Error('offline')) } as never}
      keyConfigured
    />,
  );
  fireEvent.press(screen.getByText('Stop local recording'));
  await screen.findByText('Could not confirm recording stopped.');
  expect(mockStopRecording).toHaveBeenCalledTimes(1);
});

it('keeps standalone controls advanced while unified recording stays visible', async () => {
  mockGetServerProfile.mockReturnValue(null);
  mockRecordingRemaining.mockResolvedValue(0);
  mockTestRemoteControl.mockClear();
  renderScreen(
    <PublicPreviewDiagnostics client={null} keyConfigured={undefined}>
      <Text>Server-only controls</Text>
    </PublicPreviewDiagnostics>,
  );
  expect(screen.queryByText('Server-only controls')).toBeNull();
  expect(screen.queryByText('Check subscription rights')).toBeNull();
  expect(screen.queryByLabelText('Copy connection recording')).toBeNull();
  expect(screen.queryByText('Stop local recording')).toBeNull();
  expect(screen.getByText('Unified recording')).toBeOnTheScreen();
  expect(mockTestRemoteControl).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('Advanced diagnostics'));
  expect(screen.getByText('Server-only controls')).toBeOnTheScreen();
  fireEvent.press(screen.getByText('Hide advanced diagnostics'));
  expect(screen.queryByText('Server-only controls')).toBeNull();
});
