import { type TaskBoard, type VerityClient } from '@verity/mobile';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import { useTasks } from './useTasks';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('useTasks', () => {
  it('ignores an older load that resolves after a newer refresh', async () => {
    const first = deferred<TaskBoard>();
    const second = deferred<TaskBoard>();
    const getTasks = jest
      .fn<Promise<TaskBoard>, []>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const client = { getTasks } as unknown as VerityClient;
    const { result } = renderHook(() => useTasks(client));

    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.refresh();
    });
    const newer = { id: 'newer' } as unknown as TaskBoard;
    await act(async () => second.resolve(newer));
    await refresh;
    expect(result.current.board).toBe(newer);

    const older = { id: 'older' } as unknown as TaskBoard;
    await act(async () => first.resolve(older));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.board).toBe(newer);
  });
});
