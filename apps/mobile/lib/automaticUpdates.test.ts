import type * as ExpoUpdates from 'expo-updates';

import { applyStartupUpdate, createSerialUpdateChecker } from './automaticUpdates';

type UpdatesClient = Pick<
  typeof ExpoUpdates,
  'isEnabled' | 'checkForUpdateAsync' | 'fetchUpdateAsync' | 'reloadAsync'
>;
type UpdateCheckResult = Awaited<ReturnType<UpdatesClient['checkForUpdateAsync']>>;

function makeClient(overrides: Partial<UpdatesClient> = {}): UpdatesClient {
  return {
    isEnabled: true,
    checkForUpdateAsync: jest.fn().mockResolvedValue({
      isAvailable: false,
      isRollBackToEmbedded: false,
    }),
    fetchUpdateAsync: jest.fn(),
    reloadAsync: jest.fn(),
    ...overrides,
  } as UpdatesClient;
}

describe('applyStartupUpdate', () => {
  afterEach(() => jest.useRealTimers());

  it('skips Expo Go and development runtimes where updates are disabled', async () => {
    const client = makeClient({ isEnabled: false });

    await expect(applyStartupUpdate(client)).resolves.toBe('disabled');
    expect(client.checkForUpdateAsync).not.toHaveBeenCalled();
  });

  it('continues without a download when the embedded version is current', async () => {
    const client = makeClient();

    await expect(applyStartupUpdate(client)).resolves.toBe('current');
    expect(client.fetchUpdateAsync).not.toHaveBeenCalled();
    expect(client.reloadAsync).not.toHaveBeenCalled();
  });

  it('downloads and immediately reloads an available compatible update', async () => {
    const client = makeClient({
      checkForUpdateAsync: jest.fn().mockResolvedValue({
        isAvailable: true,
        isRollBackToEmbedded: false,
      }),
      fetchUpdateAsync: jest.fn().mockResolvedValue({
        isNew: true,
        isRollBackToEmbedded: false,
      }),
      reloadAsync: jest.fn().mockResolvedValue(undefined),
    });

    await expect(applyStartupUpdate(client)).resolves.toBe('reloading');
    expect(client.fetchUpdateAsync).toHaveBeenCalledTimes(1);
    expect(client.reloadAsync).toHaveBeenCalledTimes(1);
  });

  it('applies an Expo-directed rollback to the embedded update', async () => {
    const client = makeClient({
      checkForUpdateAsync: jest.fn().mockResolvedValue({
        isAvailable: false,
        isRollBackToEmbedded: true,
      }),
      fetchUpdateAsync: jest.fn().mockResolvedValue({
        isNew: false,
        isRollBackToEmbedded: true,
      }),
      reloadAsync: jest.fn().mockResolvedValue(undefined),
    });

    await expect(applyStartupUpdate(client)).resolves.toBe('reloading');
    expect(client.reloadAsync).toHaveBeenCalledTimes(1);
  });

  it('fails open when the update service is unavailable', async () => {
    const client = makeClient({
      checkForUpdateAsync: jest.fn().mockRejectedValue(new Error('offline')),
    });

    await expect(applyStartupUpdate(client)).resolves.toBe('failed');
    expect(client.reloadAsync).not.toHaveBeenCalled();
  });

  it('fails open when the update check does not respond', async () => {
    jest.useFakeTimers();
    const client = makeClient({
      checkForUpdateAsync: jest.fn(() => new Promise(() => undefined)),
    });

    const result = applyStartupUpdate(client);
    await jest.advanceTimersByTimeAsync(5_000);

    await expect(result).resolves.toBe('failed');
    expect(client.fetchUpdateAsync).not.toHaveBeenCalled();
  });

  it('fails open when an update download stalls', async () => {
    jest.useFakeTimers();
    const client = makeClient({
      checkForUpdateAsync: jest.fn().mockResolvedValue({
        isAvailable: true,
        isRollBackToEmbedded: false,
      }),
      fetchUpdateAsync: jest.fn(() => new Promise(() => undefined)),
    });

    const result = applyStartupUpdate(client);
    await jest.advanceTimersByTimeAsync(30_000);

    await expect(result).resolves.toBe('failed');
    expect(client.reloadAsync).not.toHaveBeenCalled();
  });

  it('serializes overlapping foreground update checks', async () => {
    let resolveCheck: ((value: UpdateCheckResult) => void) | undefined;
    const client = makeClient({
      checkForUpdateAsync: jest.fn(
        () =>
          new Promise((resolve) => {
            resolveCheck = resolve;
          }),
      ),
    });
    const check = createSerialUpdateChecker(client);

    const first = check();
    await expect(check()).resolves.toBe('busy');
    resolveCheck?.({
      isAvailable: false,
      isRollBackToEmbedded: false,
    } as UpdateCheckResult);

    await expect(first).resolves.toBe('current');
    expect(client.checkForUpdateAsync).toHaveBeenCalledTimes(1);
  });
});
