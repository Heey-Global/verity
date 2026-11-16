import { createProjectOrderSaver } from '../lib/projectOrderSaver';

function setup() {
  let order = ['a', 'b', 'c'];
  const save = jest.fn<Promise<unknown>, [string[]]>().mockResolvedValue(undefined);
  const refresh = jest.fn(async () => undefined);
  const onError = jest.fn();
  const onChange = jest.fn((next: string[]) => {
    order = next;
  });
  const drop = createProjectOrderSaver({ getOrder: () => order, save, refresh, onChange, onError });
  return {
    drop,
    save,
    refresh,
    onChange,
    onError,
    setOrder: (next: string[]) => {
      order = next;
    },
  };
}

it('saves consecutive drops in order and rolls a failed latest save back to the successful one', async () => {
  const test = setup();
  test.save.mockRejectedValueOnce(new Error('offline'));
  await test.drop(['b', 'a', 'c']);
  expect(test.onChange).toHaveBeenLastCalledWith(['a', 'b', 'c']);
  expect(test.onError).toHaveBeenCalledTimes(1);
  await test.drop(['c', 'a', 'b']);
  test.save.mockRejectedValueOnce(new Error('offline'));
  await test.drop(['b', 'c', 'a']);
  expect(test.onChange).toHaveBeenLastCalledWith(['c', 'a', 'b']);
});

it('keeps a newer optimistic drop visible when an older save fails', async () => {
  const test = setup();
  test.save.mockRejectedValueOnce(new Error('offline'));
  const first = test.drop(['b', 'a', 'c']);
  const second = test.drop(['c', 'b', 'a']);
  await first;
  expect(test.onChange.mock.calls).toEqual([[['b', 'a', 'c']], [['c', 'b', 'a']]]);
  await second;
  expect(test.save.mock.calls.map(([ids]) => ids)).toEqual([
    ['b', 'a', 'c'],
    ['c', 'b', 'a'],
  ]);
});

it('reconciles the live set again before a queued request reaches the server', async () => {
  const test = setup();
  let release!: () => void;
  test.save.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const first = test.drop(['b', 'a', 'c']);
  await Promise.resolve();
  const second = test.drop(['c', 'b', 'a']);
  test.setOrder(['a', 'c', 'new']);
  expect(test.save).toHaveBeenCalledTimes(1);
  release();
  await Promise.all([first, second]);
  expect(test.save).toHaveBeenLastCalledWith(['c', 'a', 'new']);
});
