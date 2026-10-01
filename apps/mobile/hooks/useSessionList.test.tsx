import { type VerityClient, SessionListModel } from '@verity/mobile';
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
