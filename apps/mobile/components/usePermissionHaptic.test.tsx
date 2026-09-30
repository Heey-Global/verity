import { renderHook } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import { usePermissionHaptic } from './usePermissionHaptic';

jest.mock('expo-haptics', () => ({
  NotificationFeedbackType: { Warning: 'warning' },
  notificationAsync: jest.fn(() => Promise.resolve()),
}));

const tap = Haptics.notificationAsync as jest.Mock;

beforeEach(() => {
  tap.mockClear();
});

function setup(loaded: boolean, toolUseId: string | undefined) {
  return renderHook(
    ({ loaded, toolUseId }: { loaded: boolean; toolUseId: string | undefined }) =>
      usePermissionHaptic(loaded, toolUseId),
    { initialProps: { loaded, toolUseId } },
  );
}

describe('usePermissionHaptic', () => {
  it('taps once with a warning when a prompt newly blocks the agent', () => {
    const hook = setup(true, undefined);
    hook.rerender({ loaded: true, toolUseId: 'tu-1' });
    expect(tap).toHaveBeenCalledTimes(1);
    expect(tap).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Warning);
  });

  // Opening a session that is already waiting would otherwise buzz on every visit —
  // the push already announced it, and the operator is looking at the prompt.
  it('stays silent for a prompt already pending when the backlog drains', () => {
    const hook = setup(false, undefined);
    hook.rerender({ loaded: true, toolUseId: 'tu-1' });
    // A reconnect briefly clears and re-delivers the same pending prompt.
    hook.rerender({ loaded: true, toolUseId: undefined });
    hook.rerender({ loaded: true, toolUseId: 'tu-1' });
    expect(tap).not.toHaveBeenCalled();
  });

  // A reconnect replays the same pending prompt; tapping again would turn one
  // approval into a stream of buzzes on a flaky connection.
  it('does not tap again for a prompt it already announced', () => {
    const hook = setup(true, undefined);
    hook.rerender({ loaded: true, toolUseId: 'tu-1' });
    hook.rerender({ loaded: true, toolUseId: undefined });
    hook.rerender({ loaded: true, toolUseId: 'tu-1' });
    hook.rerender({ loaded: true, toolUseId: 'tu-2' });
    expect(tap).toHaveBeenCalledTimes(2);
  });

  // Switching sessions keeps the screen mounted: the new model starts unloaded, and
  // its already-pending prompt must be seeded rather than read as a fresh one.
  it('re-seeds after the session model reloads', () => {
    const hook = setup(true, 'tu-1');
    hook.rerender({ loaded: false, toolUseId: undefined });
    hook.rerender({ loaded: true, toolUseId: 'tu-9' });
    expect(tap).not.toHaveBeenCalled();
  });
});
