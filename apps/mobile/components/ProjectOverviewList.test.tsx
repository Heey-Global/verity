import { act, fireEvent, render } from '@testing-library/react-native';
import { FlatList, RefreshControl, ScrollView, Text } from 'react-native';

import { ProjectOverviewList } from './ProjectOverviewList';
import { PROJECT_SESSIONS_COLLAPSE_DURATION_MS } from './ProjectSessionsCollapse';

const items = [{ id: 'a' }, { id: 'b' }];

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function content(draggingProjectId: string | null, onRefresh = jest.fn()) {
  return (
    <ProjectOverviewList
      data={items}
      renderItem={({ item }) => <Text>{item.id}</Text>}
      draggingProjectId={draggingProjectId}
      refreshing={false}
      onRefresh={onRefresh}
    />
  );
}

// A transform-driven drag combined with native anchoring scrolls the list to a
// blank area; a refresh control unmounted mid-gesture shifts the content inset.
it('keeps the refresh control mounted and anchoring off from pickup until the groups unfold', () => {
  const onRefresh = jest.fn();
  const view = render(content(null, onRefresh));
  const list = () => view.UNSAFE_getByType(FlatList).props;
  expect(list().maintainVisibleContentPosition).toEqual({ minIndexForVisible: 0 });
  expect(list().scrollEnabled).toBe(true);
  expect(list().disableVirtualization).toBe(false);
  const staleRefresh = view.UNSAFE_getByType(RefreshControl).props.onRefresh;
  act(() => staleRefresh());
  expect(onRefresh).toHaveBeenCalledTimes(1);

  view.rerender(content('a', onRefresh));
  const expectLocked = () => {
    expect(list().maintainVisibleContentPosition).toBeUndefined();
    expect(list().scrollEnabled).toBe(false);
    expect(list().disableVirtualization).toBe(true);
    expect(list().removeClippedSubviews).toBe(false);
    expect(view.UNSAFE_getByType(RefreshControl).props.enabled).toBe(false);
  };
  expectLocked();
  expect(list().CellRendererComponentStyle({ item: { id: 'a' } })).toEqual({ zIndex: 1 });
  expect(list().CellRendererComponentStyle({ item: { id: 'b' } })).toEqual({ zIndex: 0 });
  act(() => staleRefresh());
  expect(onRefresh).toHaveBeenCalledTimes(1);

  view.rerender(content(null, onRefresh));
  expectLocked();
  act(() => jest.advanceTimersByTime(PROJECT_SESSIONS_COLLAPSE_DURATION_MS));
  expectLocked();
  act(() => jest.advanceTimersByTime(40));
  expect(list().maintainVisibleContentPosition).toEqual({ minIndexForVisible: 0 });
  expect(list().scrollEnabled).toBe(true);
  expect(list().disableVirtualization).toBe(false);
  expect(list().removeClippedSubviews).toBe(true);
  expect(view.UNSAFE_getByType(RefreshControl).props.enabled).toBe(true);
  act(() => view.UNSAFE_getByType(RefreshControl).props.onRefresh());
  expect(onRefresh).toHaveBeenCalledTimes(2);
});

it('cancels an old unlock when another drag starts during unfolding', () => {
  const view = render(content('a'));
  view.rerender(content(null));
  act(() => jest.advanceTimersByTime(100));
  view.rerender(content('b'));
  act(() => jest.advanceTimersByTime(500));
  expect(view.UNSAFE_getByType(FlatList).props.scrollEnabled).toBe(false);
  view.rerender(content(null));
  act(() => jest.advanceTimersByTime(PROJECT_SESSIONS_COLLAPSE_DURATION_MS + 39));
  expect(view.UNSAFE_getByType(FlatList).props.scrollEnabled).toBe(false);
  act(() => jest.advanceTimersByTime(1));
  expect(view.UNSAFE_getByType(FlatList).props.scrollEnabled).toBe(true);
});

// Scroll clamping can arrive before compact row measurements. Recycling the
// touched row in that interval detaches the native recognizer mid-gesture.
it('retains the bottom row while a folding list clamps to the top with stale measurements', () => {
  const projects = Array.from({ length: 40 }, (_, index) => ({ id: String(index) }));
  const content = (draggingProjectId: string | null) => (
    <ProjectOverviewList
      data={projects}
      renderItem={({ item }) => <Text>{`Project ${item.id}`}</Text>}
      keyExtractor={(item) => item.id}
      getItemLayout={(_, index) => ({ length: 300, offset: index * 300, index })}
      draggingProjectId={draggingProjectId}
      refreshing={false}
      onRefresh={jest.fn()}
    />
  );
  const view = render(content(null));
  const scrollView = () => view.UNSAFE_getByType(ScrollView);
  fireEvent(scrollView(), 'layout', { nativeEvent: { layout: { height: 600, width: 400 } } });
  fireEvent(scrollView(), 'contentSizeChange', 400, 12000);
  const scroll = (y: number, height: number) => {
    fireEvent.scroll(scrollView(), {
      nativeEvent: {
        contentOffset: { x: 0, y },
        contentSize: { width: 400, height },
        layoutMeasurement: { width: 400, height: 600 },
      },
    });
    act(() => jest.advanceTimersByTime(500));
  };
  scroll(11400, 12000);
  const touchedRow = view.getByText('Project 39');
  view.rerender(content('39'));
  fireEvent(scrollView(), 'contentSizeChange', 400, 480);
  scroll(0, 480);
  expect(view.getByText('Project 39')).toBe(touchedRow);
});
