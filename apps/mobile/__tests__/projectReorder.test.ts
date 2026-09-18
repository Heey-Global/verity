import { Animated } from 'react-native';

import {
  PROJECT_DROP_DURATION,
  projectDragOffsets,
  projectDragStartOffset,
  projectDragTargetIndex,
  settleProjectDrop,
} from '../lib/projectReorder';

describe('project drag targets', () => {
  const ids = ['a', 'b', 'c'];
  const heights = new Map([
    ['a', 60],
    ['b', 100],
    ['c', 80],
  ]);

  it('crosses each neighbouring row at its midpoint, including unequal heights', () => {
    expect(projectDragTargetIndex(ids, 'a', 49, heights)).toBe(0);
    expect(projectDragTargetIndex(ids, 'a', 50, heights)).toBe(1);
    expect(projectDragTargetIndex(ids, 'a', 139, heights)).toBe(1);
    expect(projectDragTargetIndex(ids, 'a', 140, heights)).toBe(2);
    expect(projectDragTargetIndex(ids, 'c', -49, heights)).toBe(2);
    expect(projectDragTargetIndex(ids, 'c', -50, heights)).toBe(1);
    expect(projectDragTargetIndex(ids, 'c', -130, heights)).toBe(0);
  });

  it('opens exactly one compact slot while keeping the original touch target mounted', () => {
    const offsets = projectDragOffsets(ids, ['b', 'c', 'a'], heights);
    expect(offsets.get('a')).toBe(180);
    expect(offsets.get('b')).toBe(-60);
    expect(offsets.get('c')).toBe(-60);
    expect([...projectDragOffsets(ids, ids, heights).values()]).toEqual([0, 0, 0]);
    const upward = projectDragOffsets(ids, ['c', 'a', 'b'], heights);
    expect(upward.get('c')).toBe(-160);
    expect(upward.get('a')).toBe(80);
    expect(upward.get('b')).toBe(80);
  });

  it('returns to the original slot and clamps movement at list boundaries', () => {
    expect(projectDragTargetIndex(ids, 'b', 0, heights)).toBe(1);
    expect(projectDragTargetIndex(ids, 'b', 10000, heights)).toBe(2);
    expect(projectDragTargetIndex(ids, 'b', -10000, heights)).toBe(0);
    expect(projectDragTargetIndex(ids, 'b', NaN, heights)).toBe(1);
  });

  it('keeps the grabbed row under the finger when expanded rows above it collapse', () => {
    const expanded = new Map([
      ['a', 240],
      ['b', 100],
      ['c', 180],
    ]);
    expect(projectDragStartOffset(ids, 'c', expanded, heights)).toBe(180);
    expect(projectDragStartOffset(ids, 'a', expanded, heights)).toBe(0);
    expect(projectDragStartOffset(ids, 'missing', expanded, heights)).toBe(0);
  });
});

// The overview renders every group collapsed and its fold toggle inert for as
// long as a drag is in flight, so a drop that never settles is not a lost
// animation — it is an overview whose projects stay collapsed and cannot be
// expanded again until the app is restarted.
describe('project drop settling', () => {
  const startCallback = (): ((result: { finished: boolean }) => void) => {
    const start = jest.mocked(Animated.timing).mock.results.at(-1)!.value.start as jest.Mock;
    return start.mock.calls.at(-1)![0] as (result: { finished: boolean }) => void;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Animated, 'timing').mockImplementation(
      () =>
        ({
          start: jest.fn(),
          stop: jest.fn(),
          reset: jest.fn(),
        }) as unknown as Animated.CompositeAnimation,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const drop = (settle: jest.Mock, reducedMotion = false) => {
    settleProjectDrop({
      translation: new Animated.Value(40),
      target: 120,
      reducedMotion,
      settle,
    });
  };

  it('settles once when the drop animation completes', () => {
    const settle = jest.fn();
    drop(settle);
    expect(settle).not.toHaveBeenCalled();
    startCallback()({ finished: true });
    jest.advanceTimersByTime(PROJECT_DROP_DURATION + 1000);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('settles when the drop animation is interrupted instead of finished', () => {
    const settle = jest.fn();
    drop(settle);
    startCallback()({ finished: false });
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('settles when the drop animation never reports back at all', () => {
    const settle = jest.fn();
    drop(settle);
    jest.advanceTimersByTime(PROJECT_DROP_DURATION + 200);
    expect(settle).toHaveBeenCalledTimes(1);
    startCallback()({ finished: true });
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('settles when the drop animation cannot be started', () => {
    jest.mocked(Animated.timing).mockImplementation(() => {
      throw new Error('Unable to locate attached view in the native tree');
    });
    const settle = jest.fn();
    drop(settle);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('settles immediately and without animating under reduced motion', () => {
    const settle = jest.fn();
    const translation = new Animated.Value(40);
    const setValue = jest.spyOn(translation, 'setValue');
    settleProjectDrop({ translation, target: 120, reducedMotion: true, settle });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(Animated.timing).not.toHaveBeenCalled();
    expect(setValue).toHaveBeenCalledWith(120);
  });
});
