import {
  type VerityClient,
  SessionListModel,
  publishSettledPermission,
  publishPullRequestStatusMutation,
} from '@verity/mobile';
import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { useSessionList } from './useSessionList';

let mockFocused = true;
jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => (() => void) | undefined) => {
    const React = require('react') as typeof import('react');
    React.useEffect(() => (mockFocused ? callback() : undefined), [callback, mockFocused]);
  },
}));

describe('useSessionList focus lifecycle', () => {
  afterEach(() => jest.restoreAllMocks());

  it('changes focus without adding overview renders or losing mutation refreshes', () => {
    mockFocused = true;
    jest.spyOn(SessionListModel.prototype, 'start').mockImplementation(() => {});
    jest.spyOn(SessionListModel.prototype, 'stop').mockImplementation(() => {});
    const refresh = jest.spyOn(SessionListModel.prototype, 'refresh').mockResolvedValue(undefined);
    const renders = jest.fn();
    const client = {} as VerityClient;
    const hook = renderHook(() => {
      renders();
      return useSessionList(client);
    });
    renders.mockClear();

    // Navigation already renders the route; focus must not schedule another
    // full overview/transcript render while the transition is running.
    mockFocused = false;
    hook.rerender({});
    expect(renders).toHaveBeenCalledTimes(1);
    act(() => {
      publishSettledPermission('session-1', 'tool-1');
      publishPullRequestStatusMutation({ sessionId: 'session-1' });
    });
    expect(refresh).not.toHaveBeenCalled();

    renders.mockClear();
    mockFocused = true;
    hook.rerender({});
    expect(renders).toHaveBeenCalledTimes(1);
    act(() => {
      publishSettledPermission('session-1', 'tool-1');
      publishPullRequestStatusMutation({ sessionId: 'session-1' });
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenNthCalledWith(1, { silent: true });
    expect(refresh).toHaveBeenNthCalledWith(2, { silent: true });
    hook.unmount();
  });
  it('stops on blur and only resumes on app activation while focused', () => {
    mockFocused = true;
    const start = jest.spyOn(SessionListModel.prototype, 'start').mockImplementation(() => {});
    const stop = jest.spyOn(SessionListModel.prototype, 'stop').mockImplementation(() => {});
    const listeners = new Set<(state: AppStateStatus) => void>();
    const subscription = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_, listener) => {
        listeners.add(listener);
        return {
          remove: () => {
            listeners.delete(listener);
          },
        };
      });
    const previousState = AppState.currentState;
    AppState.currentState = 'active';
    const client = {} as VerityClient;
    const hook = renderHook(() => useSessionList(client));
    expect(start).toHaveBeenCalledTimes(1);

    mockFocused = false;
    hook.rerender({});
    expect(stop).toHaveBeenCalledTimes(1);
    // An app foreground event must not restart a route hidden beneath settings.
    act(() => listeners.forEach((listener) => listener('active')));
    expect(start).toHaveBeenCalledTimes(1);

    mockFocused = true;
    hook.rerender({});
    expect(start).toHaveBeenCalledTimes(2);
    act(() => listeners.forEach((listener) => listener('background')));
    expect(stop).toHaveBeenCalledTimes(2);
    act(() => listeners.forEach((listener) => listener('active')));
    expect(start).toHaveBeenCalledTimes(3);
    hook.unmount();
    subscription.mockRestore();
    AppState.currentState = previousState;
    start.mockRestore();
    stop.mockRestore();
  });
});
