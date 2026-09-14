import type { VerityClient, VeritySettings } from '@verity/mobile';

jest.mock('expo-router', () => ({ useFocusEffect: jest.fn() }));

import {
  loadVeritySettings,
  patchVeritySettingsLocally,
  refreshSecretStatus,
  resetVeritySettingsStore,
  retryFailedVeritySettings,
  saveVeritySettings,
  veritySettingsSnapshot,
} from './settingsStore';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function settings(name = 'bot'): VeritySettings {
  return {
    gitUserName: name,
    updatedAt: '2026-09-14T00:00:00.000Z',
  } as VeritySettings;
}

afterEach(() => resetVeritySettingsStore());

it('keeps a settings failure after the parallel secret-status fetch succeeds', async () => {
  const client = {
    getVeritySettings: jest.fn().mockRejectedValue(new Error('offline')),
    getSecretStatus: jest.fn().mockResolvedValue('unlocked'),
  } as unknown as VerityClient;

  await Promise.all([loadVeritySettings(client), refreshSecretStatus(client)]);

  expect(veritySettingsSnapshot().failed).toBe(true);
});

it('keeps a secret-status failure after the parallel settings fetch succeeds', async () => {
  const client = {
    getVeritySettings: jest.fn().mockResolvedValue(settings()),
    getSecretStatus: jest.fn().mockRejectedValue(new Error('offline')),
  } as unknown as VerityClient;

  await Promise.all([loadVeritySettings(client), refreshSecretStatus(client)]);

  expect(veritySettingsSnapshot().failed).toBe(true);
});

it('ignores a save response that arrives after the cache is reset', async () => {
  const update = deferred<VeritySettings>();
  const client = {
    updateVeritySettings: jest.fn().mockReturnValue(update.promise),
  } as unknown as VerityClient;
  const saving = saveVeritySettings(client, { gitUserName: 'old-server' });
  await Promise.resolve();

  resetVeritySettingsStore();
  update.resolve(settings('old-server'));
  await saving;

  expect(veritySettingsSnapshot()).toMatchObject({ settings: null, saving: 0, savedAt: undefined });
});

it('does not send a queued save through an old client after reset', async () => {
  const firstUpdate = deferred<VeritySettings>();
  const updateVeritySettings = jest
    .fn()
    .mockReturnValueOnce(firstUpdate.promise)
    .mockResolvedValue(settings('queued'));
  const client = { updateVeritySettings } as unknown as VerityClient;
  const first = saveVeritySettings(client, { gitUserName: 'first' });
  const queued = saveVeritySettings(client, { gitUserName: 'queued' });
  await Promise.resolve();

  resetVeritySettingsStore();
  firstUpdate.resolve(settings('first'));
  await Promise.all([first, queued]);

  expect(updateVeritySettings).toHaveBeenCalledTimes(1);
  expect(veritySettingsSnapshot().settings).toBeNull();
});

it('does not let an older settings load overwrite a completed save', async () => {
  const oldLoad = deferred<VeritySettings>();
  const saved = settings('saved');
  const client = {
    getVeritySettings: jest.fn().mockReturnValue(oldLoad.promise),
    updateVeritySettings: jest.fn().mockResolvedValue(saved),
  } as unknown as VerityClient;
  const loading = loadVeritySettings(client);

  await saveVeritySettings(client, { gitUserName: 'saved' });
  oldLoad.resolve(settings('stale'));
  await loading;

  expect(veritySettingsSnapshot().settings?.gitUserName).toBe('saved');
});

it('keeps a pending secret-status refresh valid when a save completes', async () => {
  const status = deferred<'unlocked'>();
  const client = {
    getSecretStatus: jest.fn().mockReturnValue(status.promise),
    updateVeritySettings: jest.fn().mockResolvedValue(settings('saved')),
  } as unknown as VerityClient;
  const refreshing = refreshSecretStatus(client);

  await saveVeritySettings(client, { gitUserName: 'saved' });
  status.resolve('unlocked');
  await refreshing;

  expect(veritySettingsSnapshot().secretStatus).toBe('unlocked');
});

it('does not let an older load overwrite a local cache mutation', async () => {
  const oldLoad = deferred<VeritySettings>();
  const client = {
    getVeritySettings: jest.fn().mockReturnValue(oldLoad.promise),
  } as unknown as VerityClient;
  await loadVeritySettings({
    getVeritySettings: jest.fn().mockResolvedValue(settings('before')),
  } as unknown as VerityClient);
  const loading = loadVeritySettings(client);

  patchVeritySettingsLocally((current) => ({ ...current, gitUserName: 'local' }));
  oldLoad.resolve(settings('stale'));
  await loading;

  expect(veritySettingsSnapshot().settings?.gitUserName).toBe('local');
});

it('retries a failed patch after the screen that submitted it is gone', async () => {
  const patch = { dopplerServiceToken: 'secret-fixture' };
  const firstClient = {
    updateVeritySettings: jest.fn().mockRejectedValue(new Error('offline')),
  } as unknown as VerityClient;
  await saveVeritySettings(firstClient, patch);
  const retryClient = {
    updateVeritySettings: jest.fn().mockResolvedValue(settings('retried')),
  } as unknown as VerityClient;

  expect(await retryFailedVeritySettings(retryClient)).toBe(true);

  expect(retryClient.updateVeritySettings).toHaveBeenCalledWith(patch);
  expect(await retryFailedVeritySettings(retryClient)).toBe(false);
});

it('keeps every failed patch retryable across a successful reload', async () => {
  const failing = {
    updateVeritySettings: jest.fn().mockRejectedValue(new Error('offline')),
  } as unknown as VerityClient;
  await saveVeritySettings(failing, { dopplerServiceToken: 'first-fixture' });
  await saveVeritySettings(failing, { gitUserName: 'second' });
  await loadVeritySettings({
    getVeritySettings: jest.fn().mockResolvedValue(settings('server')),
  } as unknown as VerityClient);
  expect(veritySettingsSnapshot().error).toBe('Could not save settings');
  const retryClient = {
    updateVeritySettings: jest.fn().mockResolvedValue(settings('retried')),
  } as unknown as VerityClient;

  expect(await retryFailedVeritySettings(retryClient)).toBe(true);
  expect(await retryFailedVeritySettings(retryClient)).toBe(true);
  expect(await retryFailedVeritySettings(retryClient)).toBe(false);
  expect(retryClient.updateVeritySettings).toHaveBeenNthCalledWith(1, {
    dopplerServiceToken: 'first-fixture',
  });
  expect(retryClient.updateVeritySettings).toHaveBeenNthCalledWith(2, { gitUserName: 'second' });
});

it('marks generated container settings as pending application', async () => {
  await loadVeritySettings({
    getVeritySettings: jest.fn().mockResolvedValue(settings('before')),
  } as unknown as VerityClient);

  patchVeritySettingsLocally((current) => ({ ...current, gitSshPrivateKeyConfigured: true }), true);

  expect(veritySettingsSnapshot().applyPending).toBe(true);
});

it('does not retry an old value after a replacement for that field succeeds', async () => {
  await saveVeritySettings(
    {
      updateVeritySettings: jest.fn().mockRejectedValue(new Error('offline')),
    } as unknown as VerityClient,
    { dopplerServiceToken: 'old-fixture' },
  );
  const replacementClient = {
    updateVeritySettings: jest.fn().mockResolvedValue(settings('saved')),
  } as unknown as VerityClient;

  await saveVeritySettings(replacementClient, { dopplerServiceToken: 'new-fixture' });

  expect(await retryFailedVeritySettings(replacementClient)).toBe(false);
});
