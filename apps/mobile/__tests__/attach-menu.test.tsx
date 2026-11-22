import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { GmailSessionConnection } from '@verity/mobile';
import { AppState, Linking, Platform } from 'react-native';

type Listener = () => void;
const mockListeners = new Set<Listener>();
const mockLibrary = {
  permission: { status: 'granted', accessPrivileges: 'all', canAskAgain: true } as {
    status: string;
    accessPrivileges: string;
    canAskAgain: boolean;
  },
  screenshots: [] as { id: string; uri: string }[],
  recent: [] as { id: string; uri: string }[],
};
const mockRequestPermissions = jest.fn(async () => mockLibrary.permission);
jest.mock('expo-media-library/legacy', () => ({
  MediaType: { photo: 'photo' },
  SortBy: { creationTime: 'creationTime' },
  getPermissionsAsync: jest.fn(async () => mockLibrary.permission),
  requestPermissionsAsync: (...args: unknown[]) => mockRequestPermissions(...(args as [])),
  presentPermissionsPickerAsync: jest.fn(async () => undefined),
  getAssetsAsync: jest.fn(async ({ mediaSubtypes }: { mediaSubtypes?: string[] }) => ({
    assets: mediaSubtypes ? mockLibrary.screenshots : mockLibrary.recent,
  })),
  addListener: jest.fn((listener: Listener) => {
    mockListeners.add(listener);
    return { remove: () => mockListeners.delete(listener) };
  }),
}));

import { AttachMenu, type AttachMenuGoogle } from '../components/AttachMenu';

const handlers = {
  onCapturePhoto: jest.fn(),
  onPickPhotos: jest.fn(),
  onPickFiles: jest.fn(),
  onPickMeetingAudio: jest.fn(),
  onLiveMeeting: jest.fn(),
};
const image = (id: string) => ({ id, uri: `ph://${id}` });
const gmail: GmailSessionConnection = {
  enabled: true,
  accountEmail: 'alex@example.com',
  clientId: null,
  connected: true,
  source: 'session',
  mode: 'account',
};

function renderMenu(
  overrides: Partial<{ visible: boolean; google: Partial<AttachMenuGoogle> }> = {},
) {
  const onAttachRecent = jest.fn();
  const onToggle = jest.fn();
  const props = {
    anchor: { x: 12, y: 700, width: 40, height: 40 },
    handlers,
    onAttachRecent,
    google: {
      connected: true,
      loading: false,
      error: null,
      access: { gmail, calendar: { ...gmail, source: 'project' as const }, contacts: null },
      onToggle,
      ...overrides.google,
    },
    onClose: jest.fn(),
    onDismiss: jest.fn(),
  };
  const view = render(<AttachMenu visible={overrides.visible ?? true} {...props} />);
  return { ...view, props, onAttachRecent, onToggle };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListeners.clear();
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() });
  mockLibrary.permission = { status: 'granted', accessPrivileges: 'all', canAskAgain: true };
  mockLibrary.screenshots = [image('shot-2'), image('shot-1')];
  mockLibrary.recent = [image('photo-3'), image('shot-2'), image('photo-1')];
});

afterEach(() => {
  jest.mocked(AppState.addEventListener).mockRestore();
});

it('opens with the camera, then screenshots before other recent images', async () => {
  const { onAttachRecent } = renderMenu();
  const tiles = await screen.findAllByLabelText(/^Attach recent image/);
  expect(tiles).toHaveLength(4);
  expect(screen.getByLabelText('Take photo')).toBeTruthy();
  // The strip's camera replaces the row, so the camera is offered exactly once.
  expect(screen.queryByText('Take photo')).toBeNull();
  fireEvent.press(tiles[0]);
  expect(onAttachRecent).toHaveBeenCalledWith(image('shot-2'));
  fireEvent.press(tiles[2]);
  expect(onAttachRecent).toHaveBeenLastCalledWith(image('photo-3'));
});

it('shows a screenshot taken while the menu is open without attaching it', async () => {
  const { onAttachRecent } = renderMenu();
  await screen.findAllByLabelText(/^Attach recent image/);
  mockLibrary.screenshots = [image('shot-3'), ...mockLibrary.screenshots];
  await act(async () => {
    for (const listener of mockListeners) listener();
  });
  await waitFor(() => expect(screen.getAllByLabelText(/^Attach recent image/)).toHaveLength(5));
  fireEvent.press(screen.getAllByLabelText(/^Attach recent image/)[0]);
  expect(onAttachRecent).toHaveBeenCalledTimes(1);
  expect(onAttachRecent).toHaveBeenCalledWith(image('shot-3'));
});

it('rechecks photo access when returning from Settings without a library event', async () => {
  mockLibrary.permission.status = 'denied';
  const appState = jest.mocked(AppState.addEventListener);
  renderMenu();
  await screen.findByLabelText('Allow photo access');
  mockLibrary.permission.status = 'granted';
  await act(async () => {
    appState.mock.calls.find(([event]) => event === 'change')?.[1]('active');
  });
  expect(screen.getAllByLabelText(/^Attach recent image/)).toHaveLength(4);
});

it('hides the previous thumbnails while rechecking photo access on reopen', async () => {
  const view = renderMenu();
  await screen.findAllByLabelText(/^Attach recent image/);
  view.rerender(<AttachMenu visible={false} {...view.props} />);
  mockLibrary.permission.status = 'denied';
  view.rerender(<AttachMenu visible {...view.props} />);
  expect(screen.queryAllByLabelText(/^Attach recent image/)).toHaveLength(0);
  await screen.findByLabelText('Allow photo access');
});

it('stops listening to the library once the menu closes', async () => {
  const view = renderMenu();
  await screen.findAllByLabelText(/^Attach recent image/);
  expect(mockListeners.size).toBe(1);
  view.rerender(<AttachMenu visible={false} {...view.props} />);
  expect(mockListeners.size).toBe(0);
});

it('asks for photo access on the first open only', async () => {
  mockLibrary.permission = { status: 'undetermined', accessPrivileges: 'none', canAskAgain: true };
  mockRequestPermissions.mockImplementationOnce(async () => {
    mockLibrary.permission = { status: 'granted', accessPrivileges: 'all', canAskAgain: true };
    return mockLibrary.permission;
  });
  const view = renderMenu();
  await screen.findAllByLabelText(/^Attach recent image/);
  view.rerender(<AttachMenu visible={false} {...view.props} />);
  view.rerender(<AttachMenu visible {...view.props} />);
  await screen.findAllByLabelText(/^Attach recent image/);
  expect(mockRequestPermissions).toHaveBeenCalledTimes(1);
});

// Settings cannot fix a library that failed to read, so it must not be offered.
it('keeps only the camera when the library cannot be read', async () => {
  const { getAssetsAsync } = jest.requireMock('expo-media-library/legacy');
  getAssetsAsync.mockRejectedValueOnce(new Error('io'));
  renderMenu();
  await waitFor(() => expect(getAssetsAsync).toHaveBeenCalled());
  expect(screen.getByLabelText('Take photo')).toBeTruthy();
  expect(screen.queryByLabelText('Allow photo access')).toBeNull();
  expect(screen.queryAllByLabelText(/^Attach recent image/)).toHaveLength(0);
});

it('offers Settings in the strip when photo access was refused', async () => {
  mockLibrary.permission = { status: 'denied', accessPrivileges: 'none', canAskAgain: false };
  const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
  renderMenu();
  fireEvent.press(await screen.findByLabelText('Allow photo access'));
  expect(openSettings).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Take photo')).toBeTruthy();
  expect(screen.queryAllByLabelText(/^Attach recent image/)).toHaveLength(0);
});

it('lets limited access widen the selection', async () => {
  mockLibrary.permission = { status: 'granted', accessPrivileges: 'limited', canAskAgain: true };
  renderMenu();
  expect(await screen.findByLabelText('Manage')).toBeTruthy();
});

it('keeps the Take photo row where there is no library (web)', () => {
  const os = Platform.OS;
  Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
  try {
    renderMenu();
    expect(screen.getByText('Take photo')).toBeTruthy();
    expect(screen.queryByLabelText('Recent images')).toBeNull();
  } finally {
    Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
  }
});

it('switches connectors in place and leaves project access to Project settings', async () => {
  const { onToggle } = renderMenu();
  fireEvent.press(await screen.findByText('Connectors'));
  const gmailSwitch = screen.getByRole('switch', { name: 'Gmail' });
  expect(gmailSwitch).toHaveProperty('props.accessibilityState.checked', true);
  fireEvent.press(gmailSwitch);
  expect(onToggle).toHaveBeenCalledWith('gmail', false);
  fireEvent.press(screen.getByRole('switch', { name: 'Google Contacts' }));
  expect(onToggle).toHaveBeenLastCalledWith('contacts', true);
  const calendar = screen.getByRole('switch', { name: 'Google Calendar' });
  expect(calendar).toHaveProperty('props.accessibilityState.disabled', true);
  fireEvent.press(calendar);
  expect(onToggle).toHaveBeenCalledTimes(2);
  fireEvent.press(screen.getByLabelText('Back to the add menu'));
  expect(screen.getByText('Choose photo')).toBeTruthy();
});
