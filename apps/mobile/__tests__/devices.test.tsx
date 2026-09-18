import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

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
const mockRevoke = jest.fn();
const mockRename = jest.fn();
jest.mock('../lib/client', () => ({
  createVerityClient: () => ({
    listPairedDevices: () => mockList(),
    createPairingInvitation: () => mockInvite(),
    revokePairedDevice: (id: string) => mockRevoke(id),
    renamePairedDevice: (id: string, label: string) => mockRename(id, label),
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

import { Alert } from 'react-native';

import DevicesScreen from '../app/devices';
import { resetVeritySettingsStore } from '../lib/settingsStore';

const PAIRED_AT = Date.parse('2026-09-16T07:18:00Z');

beforeEach(() => {
  // The screen reports failures through the shared settings store, so a leaked
  // error would otherwise render a banner in the next test's tree.
  resetVeritySettingsStore();
  mockCopy.mockReset().mockResolvedValue(undefined);
  mockRevoke.mockReset().mockResolvedValue(undefined);
  mockRename.mockReset().mockResolvedValue(undefined);
  mockList.mockReset().mockResolvedValue([
    { id: 'current', label: 'iPhone', createdAt: PAIRED_AT, lastSeenAt: null, isCurrent: true },
    { id: 'other', label: 'iPad', createdAt: PAIRED_AT, lastSeenAt: null, isCurrent: false },
  ]);
  mockInvite.mockReset().mockResolvedValue({
    code: 'abcdefghijklmnopqrstuvwxyz_0123456789',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  });
});

it('lists the current device and creates a copyable pairing invitation', async () => {
  render(<DevicesScreen />);
  // The row's name is the rename field itself, so it must arrive carrying the
  // stored name rather than an empty box the operator has to retype.
  expect((await screen.findByLabelText('Rename iPad')).props.value).toBe('iPad');
  expect(screen.getByText('This device')).toBeOnTheScreen();
  // The current device must never offer a control that would lock this app out
  // of its own server — the row marks it, the others carry Remove.
  expect(screen.queryByLabelText('Remove iPhone')).not.toBeOnTheScreen();
  expect(screen.getByLabelText('Remove iPad')).toBeOnTheScreen();
  // Unseen devices fall back to the pairing date rather than claiming activity.
  expect(screen.getAllByText(`Paired ${new Date(PAIRED_AT).toLocaleDateString()}`)).toHaveLength(2);

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

it('removes an invitation when it expires', async () => {
  jest.useFakeTimers();
  mockInvite.mockResolvedValue({
    code: 'abcdefghijklmnopqrstuvwxyz_0123456789',
    expiresAt: new Date(Date.now() + 1_000).toISOString(),
  });
  render(<DevicesScreen />);
  await act(async () => Promise.resolve());

  fireEvent.press(screen.getByLabelText('Pair another device'));
  expect(await screen.findByTestId('pairing-qr')).toBeOnTheScreen();
  act(() => jest.advanceTimersByTime(1_000));

  expect(screen.queryByTestId('pairing-qr')).not.toBeOnTheScreen();
  expect(screen.queryByLabelText('Copy pairing link')).not.toBeOnTheScreen();
  jest.useRealTimers();
});

it('revokes the device the confirmed row belongs to', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  render(<DevicesScreen />);
  fireEvent.press(await screen.findByLabelText('Remove iPad'));

  // Confirm through the alert the way the operator would — pressing Remove with
  // no confirmation step would be the silent failure worth catching here.
  expect(mockRevoke).not.toHaveBeenCalled();
  const buttons = alert.mock.calls[0]?.[2] as Array<{ text: string; onPress?: () => void }>;
  await act(async () => buttons.find((button) => button.text === 'Remove')!.onPress!());

  expect(mockRevoke).toHaveBeenCalledWith('other');
  alert.mockRestore();
});

it('renames a device on blur, trimmed, and reloads the list', async () => {
  render(<DevicesScreen />);
  const field = await screen.findByLabelText('Rename iPad');
  fireEvent.changeText(field, '  Kitchen iPad  ');
  await act(async () => fireEvent(field, 'blur'));

  expect(mockRename).toHaveBeenCalledWith('other', 'Kitchen iPad');
  // The row's icon and its accessibility label both derive from the stored
  // name, so a rename that does not reload leaves the row lying about itself.
  expect(mockList).toHaveBeenCalledTimes(2);
});

it('keeps edits started while an earlier rename is still completing', async () => {
  let finishRename!: () => void;
  mockRename.mockReturnValue(
    new Promise<void>((resolve) => {
      finishRename = resolve;
    }),
  );
  render(<DevicesScreen />);
  const field = await screen.findByLabelText('Rename iPad');

  fireEvent.changeText(field, 'Kitchen iPad');
  fireEvent(field, 'blur');
  fireEvent(field, 'focus');
  fireEvent.changeText(field, 'Desk iPad');
  mockList.mockResolvedValue([
    { id: 'current', label: 'iPhone', createdAt: PAIRED_AT, lastSeenAt: null, isCurrent: true },
    {
      id: 'other',
      label: 'Kitchen iPad',
      createdAt: PAIRED_AT,
      lastSeenAt: null,
      isCurrent: false,
    },
  ]);
  await act(async () => finishRename());

  expect((await screen.findByLabelText('Rename Kitchen iPad')).props.value).toBe('Desk iPad');
});

it('sends overlapping renames for one device in submission order', async () => {
  const finishes: Array<() => void> = [];
  mockRename.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishes.push(resolve);
      }),
  );
  render(<DevicesScreen />);
  const field = await screen.findByLabelText('Rename iPad');

  fireEvent.changeText(field, 'Kitchen iPad');
  fireEvent(field, 'blur');
  fireEvent(field, 'focus');
  // Reverting to the last fetched label still has to be queued: the first
  // request has not landed yet, so the fetched label is no longer the pending
  // target that determines whether this is a no-op.
  fireEvent.changeText(field, 'iPad');
  fireEvent(field, 'blur');
  await waitFor(() => expect(mockRename).toHaveBeenCalledTimes(1));
  expect(mockRename).toHaveBeenLastCalledWith('other', 'Kitchen iPad');

  await act(async () => finishes[0]!());
  await waitFor(() => expect(mockRename).toHaveBeenCalledTimes(2));
  expect(mockRename).toHaveBeenLastCalledWith('other', 'iPad');
  await act(async () => finishes[1]!());
});

it('keeps the pending name authoritative until the refreshed list arrives', async () => {
  let finishList!: (devices: unknown[]) => void;
  render(<DevicesScreen />);
  const field = await screen.findByLabelText('Rename iPad');
  mockList.mockReturnValueOnce(
    new Promise((resolve) => {
      finishList = resolve;
    }),
  );

  fireEvent.changeText(field, 'Kitchen iPad');
  fireEvent(field, 'blur');
  await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  fireEvent(field, 'focus');
  fireEvent.changeText(field, 'iPad');
  fireEvent(field, 'blur');
  await act(async () => Promise.resolve());
  expect(mockRename).toHaveBeenCalledTimes(1);

  await act(async () =>
    finishList([
      { id: 'current', label: 'iPhone', createdAt: PAIRED_AT, lastSeenAt: null, isCurrent: true },
      {
        id: 'other',
        label: 'Kitchen iPad',
        createdAt: PAIRED_AT,
        lastSeenAt: null,
        isCurrent: false,
      },
    ]),
  );
  await waitFor(() => expect(mockRename).toHaveBeenCalledTimes(2));
  expect(mockRename).toHaveBeenLastCalledWith('other', 'iPad');
});

it('keeps the latest submitted draft when an earlier refresh lands and the later save fails', async () => {
  let finishFirst!: () => void;
  let rejectSecond!: (reason: Error) => void;
  mockRename
    .mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishFirst = resolve;
      }),
    )
    .mockReturnValueOnce(
      new Promise<void>((_resolve, reject) => {
        rejectSecond = reject;
      }),
    );
  render(<DevicesScreen />);
  const field = await screen.findByLabelText('Rename iPad');
  mockList.mockResolvedValue([
    { id: 'current', label: 'iPhone', createdAt: PAIRED_AT, lastSeenAt: null, isCurrent: true },
    {
      id: 'other',
      label: 'Kitchen iPad',
      createdAt: PAIRED_AT,
      lastSeenAt: null,
      isCurrent: false,
    },
  ]);

  fireEvent.changeText(field, 'Kitchen iPad');
  fireEvent(field, 'blur');
  fireEvent(field, 'focus');
  fireEvent.changeText(field, 'Desk iPad');
  fireEvent(field, 'blur');
  // Blurring the already queued target is a no-op at the network boundary, but
  // it must not clear the marker that protects this newer draft from A's reload.
  fireEvent(field, 'focus');
  fireEvent(field, 'blur');
  await act(async () => finishFirst());
  await waitFor(() => expect(mockRename).toHaveBeenCalledTimes(2));
  await act(async () => rejectSecond(new Error('device not found')));

  expect(await screen.findByText('device not found')).toBeOnTheScreen();
  expect(screen.getByLabelText('Rename Kitchen iPad').props.value).toBe('Desk iPad');
});

it('keeps a rejected rename visible after the list reloads', async () => {
  mockRename.mockRejectedValue(new Error('device not found'));
  render(<DevicesScreen />);
  const field = await screen.findByLabelText('Rename iPad');
  fireEvent.changeText(field, 'Kitchen iPad');
  await act(async () => fireEvent(field, 'blur'));

  // Reloading the list clears the banner on its way in, so reporting the
  // failure before the reload loses it: the row would snap back to the old
  // name with nothing on screen saying the rename was refused.
  expect(await screen.findByText('device not found')).toBeOnTheScreen();
  // The typed name stays put so it can be corrected on the next attempt; the
  // row's own label still comes from the server, which never accepted it.
  expect(screen.getByLabelText('Rename iPad').props.value).toBe('Kitchen iPad');
});

it('does not call the server for a blur that changes nothing', async () => {
  render(<DevicesScreen />);
  const field = await screen.findByLabelText('Rename iPad');
  // Tapping into a name and out again is the common case. A PATCH per focus
  // would be invisible from the screen and would rewrite the row every time.
  await act(async () => fireEvent(field, 'blur'));
  fireEvent.changeText(field, '   ');
  await act(async () => fireEvent(field, 'blur'));
  fireEvent.changeText(field, '  iPad  ');
  await act(async () => fireEvent(field, 'blur'));

  expect(mockRename).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Rename iPad').props.value).toBe('iPad');
});

it('adopts an external rename after an unchanged blur', async () => {
  render(<DevicesScreen />);
  const unchanged = await screen.findByLabelText('Rename iPad');
  fireEvent(unchanged, 'blur');
  mockList.mockResolvedValue([
    {
      id: 'current',
      label: 'Office iPhone',
      createdAt: PAIRED_AT,
      lastSeenAt: null,
      isCurrent: true,
    },
    {
      id: 'other',
      label: 'Kitchen iPad',
      createdAt: PAIRED_AT,
      lastSeenAt: null,
      isCurrent: false,
    },
  ]);

  const current = screen.getByLabelText('Rename iPhone');
  fireEvent.changeText(current, 'Office iPhone');
  await act(async () => fireEvent(current, 'blur'));

  expect((await screen.findByLabelText('Rename Kitchen iPad')).props.value).toBe('Kitchen iPad');
});

it('adopts an external rename after a rejected draft is reset', async () => {
  mockRename.mockRejectedValueOnce(new Error('device not found'));
  render(<DevicesScreen />);
  const field = await screen.findByLabelText('Rename iPad');
  fireEvent.changeText(field, 'Kitchen iPad');
  await act(async () => fireEvent(field, 'blur'));
  expect(await screen.findByText('device not found')).toBeOnTheScreen();

  fireEvent.changeText(field, 'iPad');
  fireEvent(field, 'blur');
  mockRename.mockResolvedValue(undefined);
  mockList.mockResolvedValue([
    {
      id: 'current',
      label: 'Office iPhone',
      createdAt: PAIRED_AT,
      lastSeenAt: null,
      isCurrent: true,
    },
    {
      id: 'other',
      label: 'Living Room iPad',
      createdAt: PAIRED_AT,
      lastSeenAt: null,
      isCurrent: false,
    },
  ]);
  const current = screen.getByLabelText('Rename iPhone');
  fireEvent.changeText(current, 'Office iPhone');
  await act(async () => fireEvent(current, 'blur'));

  expect((await screen.findByLabelText('Rename Living Room iPad')).props.value).toBe(
    'Living Room iPad',
  );
});

it('shows real activity once the server has stamped a device', async () => {
  mockList.mockResolvedValue([
    { id: 'current', label: 'iPhone', createdAt: PAIRED_AT, lastSeenAt: null, isCurrent: true },
    {
      id: 'other',
      label: 'iPad',
      createdAt: PAIRED_AT,
      lastSeenAt: Date.now() - 2 * 3_600_000,
      isCurrent: false,
    },
  ]);
  render(<DevicesScreen />);
  expect(await screen.findByText('Active 2 hours ago')).toBeOnTheScreen();
});
