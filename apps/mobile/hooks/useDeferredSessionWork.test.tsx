import { act, renderHook } from '@testing-library/react-native';
import { useDeferredSessionWork } from './useDeferredSessionWork';

it('waits for readiness and a frame opportunity, and rejects stale switch callbacks', () => {
  let next = 0;
  const frames = new Map<number, FrameRequestCallback>();
  jest.spyOn(global, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++next, callback);
    return next;
  });
  jest.spyOn(global, 'cancelAnimationFrame').mockImplementation((id) => {
    if (id != null) frames.delete(id);
  });
  const frame = () =>
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(0));
    });
  try {
    const hook = renderHook(
      ({ id, ready }: { id: string; ready: boolean }) => useDeferredSessionWork(id, ready),
      {
        initialProps: { id: 'a', ready: false },
      },
    );
    expect(frames.size).toBe(0);
    hook.rerender({ id: 'a', ready: true });
    expect(hook.result.current).toBe(false);
    frame();
    expect(hook.result.current).toBe(false);
    frame();
    expect(hook.result.current).toBe(true);
    hook.rerender({ id: 'b', ready: true });
    frame();
    const stale = [...frames.values()];
    hook.rerender({ id: 'a', ready: true });
    act(() => stale.forEach((callback) => callback(0)));
    expect(hook.result.current).toBe(false);
    frame();
    frame();
    expect(hook.result.current).toBe(true);
    hook.rerender({ id: 'c', ready: true });
    hook.unmount();
    expect(frames.size).toBe(0);
  } finally {
    jest.restoreAllMocks();
  }
});
