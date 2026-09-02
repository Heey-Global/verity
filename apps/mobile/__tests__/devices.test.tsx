import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('expo-router', () => ({
  Stack: Object.assign(() => null, { Screen: () => null }),
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock('react-native-qrcode-svg', () => {
  const { View } = jest.requireActual('react-native');
  return () => <View testID="pairing-qr" />;
});

const mockCopy = jest.fn();
jest.mock('expo-clipboard', () => ({ setStringAsync: (value: string) => mockCopy(value) }));

const mockList = jest.fn();
const mockInvite = jest.fn();
jest.mock('../lib/client', () => ({
  createVerityClient: () => ({
    listPairedDevices: () => mockList(),
    createPairingInvitation: () => mockInvite(),
    revokePairedDevice: jest.fn(),
  }),
}));
jest.mock('../lib/serverProfile', () => ({
  getServerProfile: () => ({
    version: 1,
    serverId: 'srv_0123456789abcdef',
    identityKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    activeUrl: 'https://verity-new.example:8082',
    endpoints: [
      {
        url: 'https://192.168.1.42:8082',
        transport: 'direct',
        tlsPin: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
      {
        url: 'https://verity-new.example:8082',
        transport: 'direct',
        tlsPin: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
    ],
  }),
}));

import DevicesScreen from '../app/devices';

beforeEach(() => {
  mockCopy.mockReset().mockResolvedValue(undefined);
  mockList
    .mockReset()
    .mockResolvedValue([{ id: 'current', label: 'iPad', createdAt: 1, isCurrent: true }]);
  mockInvite.mockReset().mockResolvedValue({
    code: 'abcdefghijklmnopqrstuvwxyz_0123456789',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  });
});

it('lists the current device and creates a copyable pairing invitation', async () => {
  render(<DevicesScreen />);
  expect(await screen.findByText('iPad')).toBeOnTheScreen();
  expect(screen.getByText('This device')).toBeOnTheScreen();

  fireEvent.press(screen.getByLabelText('Pair another device'));
  expect(await screen.findByTestId('pairing-qr')).toBeOnTheScreen();
  fireEvent.press(screen.getByLabelText('Copy pairing link'));
  await waitFor(() =>
    expect(mockCopy).toHaveBeenCalledWith(expect.stringMatching(/^verity:\/\/pair\?/)),
  );
  const copied = mockCopy.mock.calls[0]?.[0] as string;
  const encoded = new URL(copied).searchParams.get('payload')!;
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as { url: string };
  expect(payload.url).toBe('https://verity-new.example:8082');
});
