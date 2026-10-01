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
