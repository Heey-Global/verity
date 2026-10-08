import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

const mockTestRemoteControl = jest.fn();
const mockGetServerProfile = jest.fn();

jest.mock('expo-router', () => ({ useFocusEffect: jest.fn() }));
jest.mock('../../lib/serverProfile', () => ({
  getServerProfile: () => mockGetServerProfile(),
}));
jest.mock('../../lib/remoteControlTransport', () => ({
  testRemoteControlForUrl: (...args: unknown[]) => mockTestRemoteControl(...args),
  remoteControlFailureForUrl: jest.fn(() => null),
}));
jest.mock('./SettingsChrome', () => ({
  SettingsPanel: ({ children }: { children: React.ReactNode }) => {
    const { View } = require('react-native');
    return <View>{children}</View>;
  },
}));

import { PublicPreviewDiagnostics } from './PublicPreviewDiagnostics';

it('finishes the tunnel test while the separate Core status refresh is pending', async () => {
  mockGetServerProfile.mockReturnValue({
    activeUrl: 'https://verity.example',
    remoteControl: { installationHandle: 'saved' },
  });
  mockTestRemoteControl.mockResolvedValue({ ready: false, detail: 'probe timed out' });
  const getUplinkDiagnostics = jest.fn(() => new Promise<never>(() => undefined));

  render(<PublicPreviewDiagnostics client={{ getUplinkDiagnostics } as never} keyConfigured />);
  fireEvent.press(screen.getByRole('button', { name: 'Test Remote Control through Uplink' }));

  await waitFor(() => {
    expect(screen.getByText('Remote Control failed at probe timed out.')).toBeOnTheScreen();
    expect(screen.getByText('Test Remote Control')).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: 'Test Remote Control through Uplink' }),
    ).toBeEnabled();
  });
  expect(getUplinkDiagnostics).toHaveBeenCalledTimes(1);
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
  fireEvent.press(screen.getByText('Refresh status'));
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
  fireEvent.press(screen.getByText('Refresh status'));
  await waitFor(() => expect(screen.getByText(/Core status unavailable/u)).toBeOnTheScreen());
  fireEvent.press(screen.getByRole('button', { name: 'Test Remote Control through Uplink' }));
  await waitFor(() =>
    expect(screen.getByText('Remote Control failed at probe timed out.')).toBeOnTheScreen(),
  );
});
