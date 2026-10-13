import { act, renderHook } from '@testing-library/react-native';
import {
  AppState,
  type AppStateStatus,
  InteractionManager,
  DeviceEventEmitter,
  Keyboard,
  Platform,
  TextInput,
} from 'react-native';
import * as ReactNative from 'react-native';
import {
  KeyboardController,
  KeyboardControllerNative,
  KeyboardEvents,
  useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import { useSessionKeyboardAvoidance } from './useSessionKeyboardAvoidance';

jest.mock('react-native-keyboard-controller', () => ({
  ...require('react-native-keyboard-controller/jest'),
  KeyboardControllerNative: { viewPositionInWindow: jest.fn() },
}));
jest.mock('react-native-reanimated', () => ({
  ...require('react-native-reanimated/mock'),
  // Keep geometry across renders, as real shared values do.
  useSharedValue: (value: unknown) => require('react').useRef({ value }).current,
}));

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
  let controllerVisible: boolean;
  let events: Record<string, () => void>;
  let controllerEvents: Record<string, () => void>;
  let resume: (state: AppStateStatus) => void;
  let finishTransition: () => void;
  let removals: Array<jest.Mock | jest.SpyInstance>;
  let cancelTransition: jest.Mock;

  beforeEach(() => {
    mockFocused = true;
    visible = false;
    controllerVisible = false;
    jest.spyOn(require('react-native'), 'findNodeHandle').mockReturnValue(1);
    jest.mocked(useReanimatedKeyboardAnimation).mockReturnValue({
      height: { value: -300 },
      progress: { value: 1 },
    } as ReturnType<typeof useReanimatedKeyboardAnimation>);
    events = {};
    controllerEvents = {};
    jest.spyOn(KeyboardEvents, 'addListener').mockImplementation((name, handler) => {
      controllerEvents[name] = () => {
        controllerVisible = name !== 'keyboardDidHide';
        handler({
          height: 0,
          duration: 250,
          timestamp: 0,
          target: 0,
          type: 'default',
          appearance: 'light',
        });
      };
      const subscription = DeviceEventEmitter.addListener(`controller:${name}`, handler);
      removals.push(jest.spyOn(subscription, 'remove'));
      return subscription;
    });
    removals = [];
    cancelTransition = jest.fn();
    jest.spyOn(KeyboardController, 'isVisible').mockImplementation(() => controllerVisible);
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
    expect(result.current.frameStyle).toMatchObject({ paddingBottom: 0 });
  });

  it('avoids a keyboard already visible before the session mounted', () => {
    visible = true;
    const { result } = renderHook(useSessionKeyboardAvoidance);
    expect(result.current.enabled).toBe(true);
    expect(result.current.frameStyle).toMatchObject({ paddingBottom: 300 });
  });

  it('applies keyboard padding when opening after a hidden keyboard', () => {
    const { result } = renderHook(useSessionKeyboardAvoidance);
    expect(result.current.frameStyle).toMatchObject({ paddingBottom: 0 });
    act(() => events.keyboardDidShow());
    expect(result.current.frameStyle).toMatchObject({ paddingBottom: 300 });
  });

  it('uses the window bottom rather than subtracting the navigation header', async () => {
    visible = true;
    const { height: windowHeight } = ReactNative.Dimensions.get('window');
    jest.mocked(KeyboardControllerNative.viewPositionInWindow).mockResolvedValue({
      x: 0,
      y: 100,
      width: 400,
      height: windowHeight - 100,
    });
    const { result, rerender } = renderHook(useSessionKeyboardAvoidance);
    await act(async () => {
      await result.current.onLayout();
    });
    rerender({});
    expect(result.current.frameStyle).toMatchObject({ paddingBottom: 300 });
  });

  it('avoids only the overlap for a pane ending above the window bottom', async () => {
    visible = true;
    const { height: windowHeight } = ReactNative.Dimensions.get('window');
    jest.mocked(KeyboardControllerNative.viewPositionInWindow).mockResolvedValue({
      x: 0,
      y: 100,
      width: 400,
      height: windowHeight - 200,
    });
    const { result, rerender } = renderHook(useSessionKeyboardAvoidance);
    await act(async () => {
      await result.current.onLayout();
    });
    expect(KeyboardControllerNative.viewPositionInWindow).toHaveBeenCalledWith(1);
    rerender({});
    expect(result.current.frameStyle).toMatchObject({ paddingBottom: 200 });
  });

  it('follows the animated height throughout opening and closing', () => {
    visible = true;
    // Read the configured shared value without calling a hook outside React.
    const { result, rerender } = renderHook(useSessionKeyboardAvoidance);
    const keyboard = jest.mocked(useReanimatedKeyboardAnimation).mock.results.at(-1)?.value;
    keyboard.height.value = -150;
    rerender({});
    expect(result.current.frameStyle).toMatchObject({ paddingBottom: 150 });
    keyboard.height.value = 0;
    rerender({});
    expect(result.current.frameStyle).toMatchObject({ paddingBottom: 0 });
  });

  it('clears live padding when hiding even if the controller retains its height', () => {
    visible = true;
    const { result } = renderHook(useSessionKeyboardAvoidance);
    expect(result.current.frameStyle).toMatchObject({ paddingBottom: 300 });
    act(() => events.keyboardDidHide());
    expect(result.current.frameStyle).toMatchObject({ paddingBottom: 0 });
  });

  it('clears keyboard space when only the controller reports dismissal after sending', () => {
    visible = true;
    const { result } = renderHook(useSessionKeyboardAvoidance);
    expect(result.current.frameStyle).toMatchObject({ paddingBottom: 300 });
    // Remounting the cleared composer can lose RN's did-hide notification while
    // the controller still reports the completed dismissal.
    jest.mocked(TextInput.State.currentlyFocusedInput).mockReturnValue(noFocusedInput);
    act(() => controllerEvents.keyboardDidHide?.());
    expect(result.current.enabled).toBe(false);
    expect(result.current.frameStyle).toMatchObject({ paddingBottom: 0 });
    act(() => events[Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow']());
    expect(result.current.frameStyle).toMatchObject({ paddingBottom: 300 });
  });

  it('keeps the composer above a controller-only opening through reconciliation and resume', () => {
    const { result } = renderHook(useSessionKeyboardAvoidance);
    // RN's cached visibility can remain false despite a visible native keyboard.
    act(() => controllerEvents.keyboardWillShow?.());
    expect(result.current.frameStyle).toMatchObject({ paddingBottom: 300 });
    act(() => controllerEvents.keyboardDidShow?.());
    act(() => finishTransition());
    expect(result.current.enabled).toBe(true);
    act(() => resume('active'));
    expect(result.current.frameStyle).toMatchObject({ paddingBottom: 300 });
    act(() => controllerEvents.keyboardDidHide?.());
    expect(result.current.frameStyle).toMatchObject({ paddingBottom: 0 });
  });

  it('does not restore dismissed keyboard space from a stale RN visibility cache', () => {
    visible = true;
    const { result } = renderHook(useSessionKeyboardAvoidance);
    act(() => controllerEvents.keyboardDidHide());
    expect(result.current.frameStyle).toMatchObject({ paddingBottom: 0 });
    // Android can retain input focus after dismissal, so focus alone cannot
    // reject RN's stale visibility during a later reconciliation.
    act(() => finishTransition());
    act(() => resume('active'));
    expect(result.current.frameStyle).toMatchObject({ paddingBottom: 0 });
  });

  it('avoids an already visible controller keyboard when RN missed its opening', () => {
    controllerVisible = true;
    const { result } = renderHook(useSessionKeyboardAvoidance);
    expect(result.current.frameStyle).toMatchObject({ paddingBottom: 300 });
  });

  it('rejects controller visibility when its focused input has detached', () => {
    controllerVisible = true;
    jest.mocked(TextInput.State.currentlyFocusedInput).mockReturnValue(noFocusedInput);
    const { result } = renderHook(useSessionKeyboardAvoidance);
    expect(result.current.frameStyle).toMatchObject({ paddingBottom: 0 });
  });

  it('does not disable an opening iOS keyboard before cached visibility catches up', () => {
    if (Platform.OS !== 'ios') return;
    const { result } = renderHook(useSessionKeyboardAvoidance);
    act(() => events.keyboardWillShow());
    act(() => finishTransition());
    expect(result.current.enabled).toBe(true);
    act(() => events.keyboardDidHide());
    act(() => finishTransition());
    expect(result.current.enabled).toBe(false);
  });

  it('rejects a cached visible keyboard after its field lost focus', () => {
    visible = true;
    jest.mocked(TextInput.State.currentlyFocusedInput).mockReturnValue(noFocusedInput);
    const { result } = renderHook(useSessionKeyboardAvoidance);
    expect(result.current.enabled).toBe(false);
    expect(result.current.frameStyle).toMatchObject({ paddingBottom: 0 });
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
    expect(result.current.frameStyle).toMatchObject({ paddingBottom: 0 });
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
    expect(removals).toHaveLength(Platform.OS === 'ios' ? 7 : 6);
    for (const remove of removals) expect(remove).toHaveBeenCalledTimes(1);
  });
});
