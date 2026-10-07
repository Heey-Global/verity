import { act, renderHook } from '@testing-library/react-native';
import type { View } from 'react-native';
import { KeyboardController } from 'react-native-keyboard-controller';
import { useAttachmentMenuAnchor } from './useAttachmentMenuAnchor';

describe('attachment menu anchor', () => {
  let finishDismiss: () => void;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  let y: number;
  let measure: jest.Mock;
  let button: { current: View | null };
  let onOpen: jest.Mock;

  beforeEach(() => {
    frames = new Map();
    nextFrame = 0;
    y = 400;
    onOpen = jest.fn();
    measure = jest.fn((callback) => callback(12, y, 40, 40));
    button = { current: { measureInWindow: measure } as unknown as View };
    jest.spyOn(KeyboardController, 'dismiss').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishDismiss = resolve;
        }),
    );
    jest.spyOn(global, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    });
    jest.spyOn(global, 'cancelAnimationFrame').mockImplementation((id) => {
      if (id !== null && id !== undefined) frames.delete(id);
    });
  });

  afterEach(() => jest.restoreAllMocks());

  function advanceFrame() {
    const pending = [...frames.values()];
    frames.clear();
    act(() => pending.forEach((callback) => callback(0)));
  }

  it('measures the lowered composer after keyboard dismissal and native layout', async () => {
    const { result } = renderHook(() => useAttachmentMenuAnchor(button, onOpen));
    act(() => result.current());
    expect(KeyboardController.dismiss).toHaveBeenCalledTimes(1);
    expect(measure).not.toHaveBeenCalled();
    await act(async () => Promise.resolve());
    advanceFrame();
    advanceFrame();
    expect(measure).not.toHaveBeenCalled();
    await act(async () => finishDismiss());
    expect(measure).not.toHaveBeenCalled();
    advanceFrame();
    expect(measure).not.toHaveBeenCalled();
    // The button moves when keyboard avoidance releases its bottom padding.
    y = 720;
    advanceFrame();
    expect(onOpen).toHaveBeenCalledWith({ x: 12, y: 720, width: 40, height: 40 });
  });

  it('opens when the keyboard is already hidden', async () => {
    jest.mocked(KeyboardController.dismiss).mockResolvedValue(undefined);
    const { result } = renderHook(() => useAttachmentMenuAnchor(button, onOpen));
    await act(async () => result.current());
    advanceFrame();
    advanceFrame();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('does not open after unmounting while the keyboard closes', async () => {
    const { result, unmount } = renderHook(() => useAttachmentMenuAnchor(button, onOpen));
    act(() => result.current());
    unmount();
    await act(async () => finishDismiss());
    advanceFrame();
    advanceFrame();
    expect(measure).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('cancels pending layout measurement on unmount', async () => {
    const { result, unmount } = renderHook(() => useAttachmentMenuAnchor(button, onOpen));
    act(() => result.current());
    await act(async () => finishDismiss());
    advanceFrame();
    unmount();
    advanceFrame();
    expect(measure).not.toHaveBeenCalled();
  });

  it('ignores an obsolete request after a second tap', async () => {
    const { result } = renderHook(() => useAttachmentMenuAnchor(button, onOpen));
    act(() => result.current());
    const firstDismiss = finishDismiss;
    act(() => result.current());
    await act(async () => firstDismiss());
    advanceFrame();
    advanceFrame();
    expect(onOpen).not.toHaveBeenCalled();
    await act(async () => finishDismiss());
    advanceFrame();
    advanceFrame();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
