import { act, render } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { ForegroundUpdateSync } from '../components/ForegroundUpdateSync';
import { downloadAppUpdate } from '../lib/automaticUpdates';
jest.mock('../lib/automaticUpdates', () => ({ downloadAppUpdate: jest.fn() }));

it('checks immediately, on return and every 30 seconds only while active, then cleans up', () => {
  jest.useFakeTimers();
  const original = AppState.currentState;
  let change!: (state: AppStateStatus) => void;
  const remove = jest.fn();
  const listener = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, callback) => {
      change = callback;
      return { remove };
    });
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    value: 'active',
    writable: true,
  });
  try {
    const view = render(<ForegroundUpdateSync />);
    expect(downloadAppUpdate).toHaveBeenCalledTimes(1);
    act(() => {
      jest.advanceTimersByTime(30_000);
    });
    expect(downloadAppUpdate).toHaveBeenCalledTimes(2);
    act(() => {
      AppState.currentState = 'background';
      change('background');
      jest.advanceTimersByTime(60_000);
    });
    expect(downloadAppUpdate).toHaveBeenCalledTimes(2);
    act(() => {
      AppState.currentState = 'active';
      change('active');
      change('active');
    });
    expect(downloadAppUpdate).toHaveBeenCalledTimes(3);
    view.unmount();
    act(() => {
      jest.advanceTimersByTime(30_000);
    });
    expect(downloadAppUpdate).toHaveBeenCalledTimes(3);
    expect(remove).toHaveBeenCalledTimes(1);
  } finally {
    listener.mockRestore();
    AppState.currentState = original;
    jest.useRealTimers();
  }
});
