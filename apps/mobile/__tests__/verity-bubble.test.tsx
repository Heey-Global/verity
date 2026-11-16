// The floating V (components/VerityBubble.tsx).
//
// What is worth guarding: it is a whole button inside the screen, a little in
// from the edge, carrying Verity's mark rather than a cyan tint; and on a phone's
// Home, which has her header and "Tell Verity", it steps back instead of sitting
// on the cards.
const mockPathname = { value: '/session/s1' };
jest.mock('expo-router', () => ({
  usePathname: () => mockPathname.value,
  useGlobalSearchParams: () => ({}),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(), ImpactFeedbackStyle: {} }));
const noop = () => () => undefined;
jest.mock('../lib/sharedTaskContext', () => ({
  refreshTaskContext: jest.fn(async () => undefined),
  startTaskContext: () => () => undefined,
  useTaskContext: () => ({ projects: [], sessions: [], projectsScope: null }),
}));
jest.mock('../lib/client', () => ({ subscribeVerityBaseUrl: noop }));
jest.mock('../lib/authToken', () => ({ subscribeAuthToken: noop }));
jest.mock('../lib/browserSession', () => ({ subscribeBrowserSession: noop }));
jest.mock('../lib/liveMeetingSession', () => ({ subscribeMeeting: noop }));
jest.mock('../lib/liveMeetingSync', () => ({ subscribeFollowedRemoteMeeting: noop }));
jest.mock('../lib/tasksStore', () => ({
  taskAccountScope: () => 'account',
  refreshTasks: jest.fn(async () => undefined),
  startTasksStore: () => () => undefined,
  useTasks: () => ({ tasks: [] }),
}));
jest.mock('../lib/taskPreferences', () => ({
  saveTaskPreferences: jest.fn(async () => undefined),
  useTaskPreferences: () => ({ enabled: true, side: 'right', fraction: 0.5, tab: 'mine' }),
}));
jest.mock('../lib/voiceShortcut', () => ({ subscribeVerityShortcut: noop }));
jest.mock('../lib/verityConversation', () => ({
  useVerity: () => ({ conversation: null, outbox: [] }),
}));
jest.mock('../lib/taskPanelEvents', () => ({ subscribeTasksPanel: noop }));
jest.mock('../lib/watchCapture', () => ({ startWatchInbox: () => () => undefined }));
jest.mock('../components/VerityPanel', () => ({ VerityPanel: () => null }));
jest.mock('../components/TasksPanel', () => ({ TasksPanel: () => null }));
jest.mock('../hooks/useTaskCaptureGesture', () => ({
  useTaskCaptureGesture: () => ({
    onPressIn: jest.fn(),
    onPress: jest.fn(),
    onLongPress: jest.fn(),
    claimDrag: () => false,
  }),
}));

import { act, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { VerityBubble, dockedX } from '../components/VerityBubble';
import { setHomeShowsVerity } from '../lib/homeVerity';
import { darkTheme, lightTheme } from '../theme/tokens';

afterEach(() => {
  mockPathname.value = '/session/s1';
  act(() => setHomeShowsVerity(false));
});

it('rests as a whole circle a little in from either edge', () => {
  // Half of the old 60pt circle lay outside the screen.
  for (const side of ['left', 'right'] as const) {
    const x = dockedX(side, 390);
    expect(x).toBeGreaterThanOrEqual(8);
    expect(x + 52).toBeLessThanOrEqual(390 - 8);
  }
});

it('shows Verity’s mark on the app surface, not a cyan tint', () => {
  render(<VerityBubble />);
  expect(screen.getByRole('button', { name: 'Verity' })).toBeTruthy();
  expect(screen.getByTestId('verity-mark')).toBeTruthy();
  const { backgroundColor } = StyleSheet.flatten(
    screen.getByTestId('verity-bubble-circle').props.style,
  );
  expect([darkTheme.colors.surface, lightTheme.colors.surface]).toContain(backgroundColor);
});

it('steps back on a phone’s Home, where her header and field are', () => {
  mockPathname.value = '/';
  render(<VerityBubble />);
  expect(screen.getByTestId('verity-bubble')).toBeTruthy();
  act(() => setHomeShowsVerity(true));
  expect(screen.queryByTestId('verity-bubble')).toBeNull();
  // Elsewhere it stays, also while Home reports its own way in.
  mockPathname.value = '/project/p1';
  render(<VerityBubble />);
  expect(screen.getByTestId('verity-bubble')).toBeTruthy();
});
