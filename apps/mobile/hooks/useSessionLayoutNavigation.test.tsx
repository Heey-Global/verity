import { render, renderHook } from '@testing-library/react-native';
import { SplitScreenRedirect } from '../components/SplitScreenRedirect';
import { sessionLayout } from '../lib/sessionLayout';
import { useSessionLayoutNavigation } from './useSessionLayoutNavigation';

const mockPush = jest.fn();
const mockDismissTo = jest.fn();
let mockFocused = true;

jest.mock('expo-router', () => ({
  useIsFocused: () => mockFocused,
  router: {
    push: (href: unknown) => mockPush(href),
    dismissTo: (href: unknown) => mockDismissTo(href),
  },
  useFocusEffect: (callback: () => void) => {
    const { useEffect } = jest.requireActual<typeof import('react')>('react');
    useEffect(() => {
      if (mockFocused) callback();
    }, [callback, mockFocused]);
  },
}));

beforeEach(() => {
  mockFocused = true;
  mockPush.mockReset();
  mockDismissTo.mockReset();
});

const target = { targetMessageId: 'message/3', targetSearchQuery: 'needle', retrySecret: '1' };

it('keeps the same session and target across collapse and expansion', () => {
  const { rerender } = renderHook(
    ({ width, id }: { width: number; id: string }) =>
      useSessionLayoutNavigation(sessionLayout(width).wide, id, target),
    { initialProps: { width: 834, id: 'session/1' } },
  );
  expect(mockPush).not.toHaveBeenCalled();
  rerender({ width: 768, id: 'session/2' });
  expect(mockPush).not.toHaveBeenCalled();
  rerender({ width: 767, id: 'session/2' });
  expect(mockPush).toHaveBeenCalledTimes(1);
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/session/[id]',
    params: { id: 'session/2', ...target },
  });
  // Widening the single-session route pops to the existing overview, preserving
  // its selection rather than adding a duplicate home screen to the back stack.
  const route = render(<SplitScreenRedirect id="session/2" {...target} />);
  expect(mockDismissTo).toHaveBeenCalledTimes(1);
  expect(mockDismissTo).toHaveBeenCalledWith({
    pathname: '/',
    params: { selected: 'session/2', ...target },
  });
  route.unmount();
  rerender({ width: 834, id: 'session/2' });
  rerender({ width: 767, id: 'session/2' });
  expect(mockPush).toHaveBeenCalledTimes(2);
});

it('does not reopen a selected session when returning to the narrow list', () => {
  const { rerender } = renderHook(
    ({ wide }: { wide: boolean }) => useSessionLayoutNavigation(wide, 'session/1', {}),
    {
      initialProps: { wide: true },
    },
  );
  rerender({ wide: false });
  expect(mockPush).toHaveBeenCalledTimes(1);
  mockFocused = false;
  rerender({ wide: false });
  mockFocused = true;
  rerender({ wide: false });
  expect(mockPush).toHaveBeenCalledTimes(1);
});

it('does not navigate over another screen when the window shrinks in the background', () => {
  const { rerender } = renderHook(
    ({ wide }: { wide: boolean }) => useSessionLayoutNavigation(wide, 'session/1', {}),
    {
      initialProps: { wide: true },
    },
  );
  mockFocused = false;
  rerender({ wide: false });
  mockFocused = true;
  rerender({ wide: false });
  expect(mockPush).not.toHaveBeenCalled();
});

it('keeps an unselected overview open when it becomes narrow', () => {
  const { rerender } = renderHook(
    ({ wide }: { wide: boolean }) => useSessionLayoutNavigation(wide, null, {}),
    {
      initialProps: { wide: true },
    },
  );
  rerender({ wide: false });
  expect(mockPush).not.toHaveBeenCalled();
});

it('opens a cold session link into the split with its target selected', () => {
  render(<SplitScreenRedirect id="session/deep-link" {...target} />);
  expect(mockDismissTo).toHaveBeenCalledWith({
    pathname: '/',
    params: { selected: 'session/deep-link', ...target },
  });
});
