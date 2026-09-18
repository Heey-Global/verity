import { act, render } from '@testing-library/react-native';
import { FlatList, RefreshControl, Text } from 'react-native';

import { ProjectOverviewList } from './ProjectOverviewList';
import { PROJECT_SESSIONS_COLLAPSE_DURATION_MS } from './ProjectSessionsCollapse';

const items = [{ id: 'a' }, { id: 'b' }];

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('locks native scrolling and anchoring through drag and the unfolding interval', () => {
  const onRefresh = jest.fn();
  const content = (draggingProjectId: string | null) => (
    <ProjectOverviewList
      data={items}
      renderItem={({ item }) => <Text>{item.id}</Text>}
      draggingProjectId={draggingProjectId}
      refreshing={false}
      onRefresh={onRefresh}
    />
  );
  const view = render(content(null));
  const list = () => view.UNSAFE_getByType(FlatList).props;
  expect(list().maintainVisibleContentPosition).toEqual({ minIndexForVisible: 0 });
  expect(list().scrollEnabled).toBe(true);
  const staleRefresh = view.UNSAFE_getByType(RefreshControl).props.onRefresh;
  act(() => staleRefresh());
  expect(onRefresh).toHaveBeenCalledTimes(1);

  view.rerender(content('a'));
  const expectLocked = () => {
    expect(list().maintainVisibleContentPosition).toBeUndefined();
    expect(list().scrollEnabled).toBe(false);
    expect(list().bounces).toBe(false);
    expect(list().alwaysBounceVertical).toBe(false);
    expect(list().removeClippedSubviews).toBe(false);
    expect(list().refreshControl).toBeUndefined();
  };
  expectLocked();
  act(() => staleRefresh());
  expect(onRefresh).toHaveBeenCalledTimes(1);
  view.rerender(content(null));
  expectLocked();
  act(() => jest.advanceTimersByTime(PROJECT_SESSIONS_COLLAPSE_DURATION_MS));
  expectLocked();
  act(() => staleRefresh());
  expect(onRefresh).toHaveBeenCalledTimes(1);
  act(() => jest.advanceTimersByTime(40));
  expect(list().maintainVisibleContentPosition).toEqual({ minIndexForVisible: 0 });
  expect(list().scrollEnabled).toBe(true);
  expect(list().bounces).toBe(true);
  expect(list().alwaysBounceVertical).toBe(true);
  expect(list().removeClippedSubviews).toBe(true);
  act(() => view.UNSAFE_getByType(RefreshControl).props.onRefresh());
  expect(onRefresh).toHaveBeenCalledTimes(2);
});

it('cancels an old unlock when another drag starts during unfolding', () => {
  const content = (draggingProjectId: string | null) => (
    <ProjectOverviewList
      data={items}
      renderItem={({ item }) => <Text>{item.id}</Text>}
      draggingProjectId={draggingProjectId}
      refreshing={false}
      onRefresh={jest.fn()}
    />
  );
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
