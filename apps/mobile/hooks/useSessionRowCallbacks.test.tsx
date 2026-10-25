import type { SessionSummary } from '@verity/mobile';
import { renderHook } from '@testing-library/react-native';
import { useSessionRowCallbacks } from './useSessionRowCallbacks';

function options() {
  return {
    sessions: [{ sessionId: 'a' }, { sessionId: 'b' }] as SessionSummary[],
    scope: 'project',
    reordering: true,
    onRename: jest.fn(),
    onFavorite: jest.fn(),
    onDelete: jest.fn(),
    onSelect: jest.fn(),
    onOpen: jest.fn(),
    onReorder: jest.fn(),
  };
}

it('keeps row actions stable across unrelated parent renders', () => {
  const props = options();
  const hook = renderHook(() => useSessionRowCallbacks(props));
  const actions = hook.result.current.get('a');
  hook.rerender({});
  // Fresh callbacks would defeat memoized rows on every selection update.
  expect(hook.result.current.get('a')).toBe(actions);
});

it('uses updated session snapshots and handlers for every action', () => {
  const props = options();
  const hook = renderHook((input: typeof props) => useSessionRowCallbacks(input), {
    initialProps: props,
  });
  const session = { ...props.sessions[0]!, name: 'updated' };
  const next = { ...props, sessions: [session, props.sessions[1]!], onSelect: jest.fn() };
  hook.rerender(next);
  const actions = hook.result.current.get('a')!;
  actions.onRename();
  actions.onOpenLinks();
  actions.onToggleFavorite();
  actions.onDelete();
  actions.onOpen();
  actions.onSelect?.();
  expect(props.onRename.mock.calls).toEqual([[session], [{ ...session, openLinks: true }]]);
  for (const handler of [props.onFavorite, props.onDelete, props.onOpen]) {
    expect(handler).toHaveBeenCalledWith(session);
  }
  expect(next.onSelect).toHaveBeenCalledWith('a');
  expect(props.onSelect).not.toHaveBeenCalled();
});

it('updates reorder boundaries and removes selection actions in narrow layout', () => {
  const props = options();
  const hook = renderHook((input: typeof props) => useSessionRowCallbacks(input), {
    initialProps: props,
  });
  expect(hook.result.current.get('a')!.onMoveUp).toBeUndefined();
  hook.result.current.get('a')!.onMoveDown?.();
  expect(props.onReorder).toHaveBeenCalledWith('project', ['session:b', 'session:a']);
  hook.rerender({ ...props, sessions: [...props.sessions].reverse() });
  expect(hook.result.current.get('a')!.onMoveDown).toBeUndefined();
  hook.result.current.get('a')!.onMoveUp?.();
  expect(props.onReorder).toHaveBeenLastCalledWith('project', ['session:a', 'session:b']);
  const narrow = renderHook(() =>
    useSessionRowCallbacks({ ...props, onSelect: undefined, reordering: false }),
  );
  expect(narrow.result.current.get('a')!.onSelect).toBeUndefined();
  expect(narrow.result.current.get('a')!.onMoveDown).toBeUndefined();
});

it('retains sibling callbacks when one session changes and when the input array is rebuilt', () => {
  const props = options();
  const hook = renderHook((input: typeof props) => useSessionRowCallbacks(input), {
    initialProps: props,
  });
  const a = hook.result.current.get('a');
  const b = hook.result.current.get('b');
  hook.rerender({ ...props, sessions: [...props.sessions] });
  expect(hook.result.current.get('a')).toBe(a);
  expect(hook.result.current.get('b')).toBe(b);
  const changed = { ...props.sessions[0]!, name: 'new name' };
  hook.rerender({ ...props, sessions: [changed, props.sessions[1]!] });
  expect(hook.result.current.get('a')).not.toBe(a);
  expect(hook.result.current.get('b')).toBe(b);
  hook.result.current.get('a')!.onOpen();
  expect(props.onOpen).toHaveBeenLastCalledWith(changed);
});
