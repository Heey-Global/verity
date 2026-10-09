import { act, render, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo, Animated } from 'react-native';
import { MeetingWave } from './MeetingWave';

it('keeps the listening wave still for Reduce Motion and reacts to preference changes', async () => {
  let changed: (value: boolean) => void = () => undefined;
  const setting = jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  const listener = jest
    .spyOn(AccessibilityInfo, 'addEventListener')
    .mockImplementation((_event, handler) => {
      changed = handler as unknown as (value: boolean) => void;
      return { remove: jest.fn() } as ReturnType<typeof AccessibilityInfo.addEventListener>;
    });
  const start = jest.fn(),
    stop = jest.fn();
  const loop = jest.spyOn(Animated, 'loop').mockReturnValue({ start, stop, reset: jest.fn() });
  try {
    const view = render(<MeetingWave active />);
    await waitFor(() => expect(setting).toHaveBeenCalled());
    expect(start).not.toHaveBeenCalled();
    act(() => changed(false));
    await waitFor(() => expect(start).toHaveBeenCalled());
    act(() => changed(true));
    expect(stop).toHaveBeenCalled();
    view.unmount();
  } finally {
    setting.mockRestore();
    listener.mockRestore();
    loop.mockRestore();
  }
});
