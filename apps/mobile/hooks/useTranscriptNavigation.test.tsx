import { act, renderHook } from '@testing-library/react-native';
import { useTranscriptNavigation } from './useTranscriptNavigation';

describe('useTranscriptNavigation', () => {
  it('tracks the exact viewport without rendering while navigation targets stay the same', () => {
    const indices = [0, 5, 10];
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useTranscriptNavigation(indices);
    });
    act(() => result.current.updateVisibleIndex(1));
    const before = renders;
    expect(result.current.prevUserIndex).toBe(5);
    expect(result.current.nextUserIndex).toBe(0);
    act(() => result.current.updateVisibleIndex(3));
    // State per crossed prose row silently rerenders the entire session screen.
    expect(renders).toBe(before);
    expect(result.current.oldestVisibleIndexRef.current).toBe(3);
    act(() => result.current.updateVisibleIndex(5));
    expect(result.current.prevUserIndex).toBe(10);
    expect(result.current.nextUserIndex).toBe(0);
    act(() => result.current.updateVisibleIndex(6));
    expect(result.current.nextUserIndex).toBe(5);
  });

  it('refreshes targets when history or bookmarks change without moving the cursor', () => {
    const { result, rerender } = renderHook(
      ({ indices }: { indices: number[] }) => useTranscriptNavigation(indices),
      { initialProps: { indices: [0, 5] } },
    );
    act(() => result.current.updateVisibleIndex(6));
    expect(result.current.prevUserIndex).toBe(-1);
    rerender({ indices: [0, 5, 10] });
    expect(result.current.prevUserIndex).toBe(10);
    expect(result.current.oldestVisibleIndexRef.current).toBe(6);
    rerender({ indices: [0, 10] });
    expect(result.current.nextUserIndex).toBe(0);
  });
});
