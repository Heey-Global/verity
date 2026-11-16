import { act, renderHook } from '@testing-library/react-native';
import type { SessionDirectory } from '@verity/mobile';
import { useCodeWorkspaceAvailability } from './useCodeWorkspaceAvailability';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
const available = {
  codeAvailable: true,
  workspaceKind: 'code',
  entries: [{ name: 'saved.ts' }],
} as SessionDirectory;

it('reloads the empty listing after an external restore becomes available', async () => {
  const listSessionFiles = jest
    .fn()
    .mockResolvedValueOnce({ codeAvailable: false })
    .mockResolvedValue(available);
  const onAvailable = jest.fn();
  const onReload = jest.fn();
  const { unmount } = renderHook(() =>
    useCodeWorkspaceAvailability({
      client: { listSessionFiles },
      sessionId: 's',
      codeAvailable: false,
      onAvailable,
      onReload,
    }),
  );
  await act(async () => {
    await jest.advanceTimersByTimeAsync(5000);
  });
  expect(onReload).not.toHaveBeenCalled();
  await act(async () => {
    await jest.advanceTimersByTimeAsync(5000);
  });
  expect(onAvailable).toHaveBeenCalledWith(available);
  expect(onReload).toHaveBeenCalledTimes(1);
  await act(async () => {
    await jest.advanceTimersByTimeAsync(5000);
  });
  expect(listSessionFiles).toHaveBeenCalledTimes(2);
  unmount();
});

it('ignores an availability response after the sheet closes', async () => {
  let resolve!: (directory: SessionDirectory) => void;
  const listSessionFiles = jest.fn(
    () =>
      new Promise<SessionDirectory>((done) => {
        resolve = done;
      }),
  );
  const onReload = jest.fn();
  const onAvailable = jest.fn();
  const { unmount } = renderHook(() =>
    useCodeWorkspaceAvailability({
      client: { listSessionFiles },
      sessionId: 's',
      codeAvailable: false,
      onAvailable,
      onReload,
    }),
  );
  await act(async () => {
    await jest.advanceTimersByTimeAsync(5000);
  });
  unmount();
  await act(async () => {
    resolve(available);
  });
  expect(onAvailable).not.toHaveBeenCalled();
  expect(onReload).not.toHaveBeenCalled();
});
