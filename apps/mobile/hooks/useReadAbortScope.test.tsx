import { act, renderHook } from '@testing-library/react-native';
import { useReadAbortScope } from './useReadAbortScope';

it('aborts a session screen read batch on replacement, identity change and unmount', () => {
  const client = {};
  const hook = renderHook(
    ({ sessionId }: { sessionId: string }) => useReadAbortScope(client, sessionId),
    {
      initialProps: { sessionId: 'first' },
    },
  );
  let first!: AbortController;
  let replacement!: AbortController;
  act(() => {
    first = hook.result.current();
    replacement = hook.result.current();
  });
  expect(first.signal.aborted).toBe(true);
  expect(replacement.signal.aborted).toBe(false);
  hook.rerender({ sessionId: 'second' });
  expect(replacement.signal.aborted).toBe(true);
  let second!: AbortController;
  act(() => {
    second = hook.result.current();
  });
  hook.unmount();
  expect(second.signal.aborted).toBe(true);
});
