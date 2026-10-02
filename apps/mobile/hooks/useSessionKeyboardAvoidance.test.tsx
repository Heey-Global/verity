import { act, renderHook } from '@testing-library/react-native';
import {
  AppState,
  type AppStateStatus,
  InteractionManager,
  Keyboard,
  Platform,
  TextInput,
} from 'react-native';
import { useSessionKeyboardAvoidance } from './useSessionKeyboardAvoidance';

let mockFocused = true;
// The public RN declaration omits the null returned by TextInputState at runtime.
const noFocusedInput = null as unknown as ReturnType<typeof TextInput.State.currentlyFocusedInput>;

jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => (() => void) | void) => {
    const React = require('react');
    React.useEffect(() => (mockFocused ? callback() : undefined), [callback, mockFocused]);
  },
}));

describe('session keyboard avoidance', () => {
  let visible: boolean;
  let events: Record<string, () => void>;
  let resume: (state: AppStateStatus) => void;
  let finishTransition: () => void;
  let removals: Array<jest.Mock | jest.SpyInstance>;
  let cancelTransition: jest.Mock;

  beforeEach(() => {
    mockFocused = true;
    visible = false;
    events = {};
    removals = [];
    cancelTransition = jest.fn();
    jest.spyOn(Keyboard, 'isVisible').mockImplementation(() => visible);
    jest
      .spyOn(TextInput.State, 'currentlyFocusedInput')
      .mockReturnValue({} as NonNullable<ReturnType<typeof TextInput.State.currentlyFocusedInput>>);
    const addKeyboardListener = Keyboard.addListener.bind(Keyboard);
    jest.spyOn(Keyboard, 'addListener').mockImplementation((name, handler) => {
      events[name] = () =>
        handler({
          duration: 250,
          easing: 'keyboard',
          endCoordinates: { height: 0, width: 0, screenX: 0, screenY: 0 },
        });
      const subscription = addKeyboardListener(name, handler);
      const remove = jest.spyOn(subscription, 'remove');
      removals.push(remove);
      return subscription;
    });
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_name, handler) => {
      resume = handler;
      const remove = jest.fn();
      removals.push(remove);
      return { remove };
    });
    jest.spyOn(InteractionManager, 'runAfterInteractions').mockImplementation((callback) => {
      finishTransition = callback as () => void;
      return {
        cancel: cancelTransition,
        then: jest.fn(),
        done: jest.fn(),
      };
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('does not inherit keyboard space when entering with no visible keyboard', () => {
    const { result } = renderHook(useSessionKeyboardAvoidance);
    expect(result.current.enabled).toBe(false);
    expect(result.current.resetStyle).toMatchObject({ paddingBottom: 0 });
  });

  it('avoids a keyboard already visible before the session mounted', () => {
    visible = true;
    const { result } = renderHook(useSessionKeyboardAvoidance);
    expect(result.current.enabled).toBe(true);
  });

  it('rejects a cached visible keyboard after its field lost focus', () => {
    visible = true;
    jest.mocked(TextInput.State.currentlyFocusedInput).mockReturnValue(noFocusedInput);
    const { result } = renderHook(useSessionKeyboardAvoidance);
    expect(result.current.enabled).toBe(false);
    expect(result.current.resetStyle).toMatchObject({ paddingBottom: 0 });
  });

  it('clears cached visibility after navigation detaches the focused field', () => {
    visible = true;
    const { result } = renderHook(useSessionKeyboardAvoidance);
    jest.mocked(TextInput.State.currentlyFocusedInput).mockReturnValue(noFocusedInput);
    act(() => finishTransition());
    expect(result.current.enabled).toBe(false);
  });

  it('follows opening and keeps avoidance until closing finishes', () => {
    const { result } = renderHook(useSessionKeyboardAvoidance);
    act(() => events[Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow']());
    expect(result.current.enabled).toBe(true);
    // A will-hide event must not snap the composer down mid-animation.
    act(() => events.keyboardWillHide?.());
    expect(result.current.enabled).toBe(true);
    act(() => events.keyboardDidHide());
    expect(result.current.enabled).toBe(false);
  });

  it('reconciles a dismissal during navigation without a hide event', () => {
    visible = true;
    const { result } = renderHook(useSessionKeyboardAvoidance);
    visible = false;
    act(() => finishTransition());
    expect(result.current.enabled).toBe(false);
  });

  it('catches an opening that began before the session subscribed', () => {
    const { result } = renderHook(useSessionKeyboardAvoidance);
    act(() => events.keyboardDidShow());
    expect(result.current.enabled).toBe(true);
  });

  it('reconciles visibility when returning to a retained session', () => {
    visible = true;
    const { result, rerender } = renderHook(useSessionKeyboardAvoidance);
    mockFocused = false;
    rerender({});
    expect(result.current.enabled).toBe(false);
    expect(result.current.resetStyle).toMatchObject({ paddingBottom: 0 });
    visible = false;
    mockFocused = true;
    rerender({});
    expect(result.current.enabled).toBe(false);
  });

  it('recovers after returning from the background without a hide event', () => {
    visible = true;
    const { result } = renderHook(useSessionKeyboardAvoidance);
    visible = false;
    act(() => resume('background'));
    expect(result.current.enabled).toBe(true);
    act(() => resume('active'));
    expect(result.current.enabled).toBe(false);
  });

  it('removes listeners and cancels pending reconciliation on leaving', () => {
    const { unmount } = renderHook(useSessionKeyboardAvoidance);
    unmount();
    expect(cancelTransition).toHaveBeenCalledTimes(1);
    expect(removals).toHaveLength(Platform.OS === 'ios' ? 4 : 3);
    for (const remove of removals) expect(remove).toHaveBeenCalledTimes(1);
  });
});
