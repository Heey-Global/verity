import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { DockerClient } from '../docker.js';
import type { RestoreJob } from './restore-job.js';
const f = vi.hoisted(() => ({
  stopped: true,
  marker: '',
  start: vi.fn(),
  stop: vi.fn(),
  initialize: vi.fn(),
  save: vi.fn(),
  query: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({
  chmod: vi.fn(),
  chown: vi.fn(),
  mkdir: vi.fn(),
  rm: f.remove,
  open: async () => ({
    fd: 42,
    stat: async () => ({ isFile: () => true, isDirectory: () => false, nlink: 1 }),
    chown: async () => {},
    sync: async () => {},
    close: async () => {},
  }),
  opendir: async function* () {},
}));
vi.mock('./repository.js', () => ({
  readBounded: async (path: string) =>
    Buffer.from(
      path.endsWith('.verity-backup-target')
        ? 'a0bafbe1-8c69-4d18-9b96-0cd5101aa701'
        : path.endsWith('.verity-recovery-pending')
          ? f.marker
          : 'fixture',
    ),
  writeDurable: f.save,
}));
vi.mock('./destination.js', () => ({
  BackupDestination: { open: async () => ({ close: async () => {} }) },
}));
vi.mock('./restore-backup.js', () => ({ initializeRestoredBackup: f.initialize }));
vi.mock('./restore-canonical-runtime.js', () => ({
  startCanonicalRestoreDatabase: f.start,
  stopRestoreTrialRuntime: f.stop,
  withCanonicalRestoreClient: async (_: unknown, run: (client: unknown) => Promise<void>) => {
    if (f.stopped) throw new Error('database stopped');
    await run({ query: f.query });
  },
}));
import { createInstallerRestoreInitializer } from './restore-installer-main.js';

it('resumes initialization after the previous successful attempt stopped its database', async () => {
  f.start.mockImplementation(async () => {
    f.stopped = false;
  });
  f.stop.mockImplementation(async () => {
    f.stopped = true;
  });
  f.query.mockResolvedValue({ rows: [{ id: 1 }] });
  f.initialize.mockImplementation(async ({ enable }: { enable: () => Promise<void> }) => {
    await enable();
    return { repositoryNumber: 1, keyGeneration: 1 };
  });
  const job = { id: randomUUID(), installationId: randomUUID(), phase: 'accepted' } as RestoreJob;
  f.marker = job.id;
  const initialize = createInstallerRestoreInitializer(
    {
      action: 'advance',
      root: '/restore-state',
      hostRoot: '/host',
      backupDirectory: '/destination',
      previousComposeProject: 'verity',
      tufCachePath: '/tuf',
      addresses: ['127.0.0.1'],
    },
    {} as DockerClient,
    new AbortController().signal,
  );
  await initialize(job, 'private-key');
  expect(f.stopped).toBe(true);
  await initialize(job, 'private-key');
  expect(f.query).toHaveBeenCalledTimes(2);
  expect(f.start).toHaveBeenCalledTimes(2);
  expect(f.stop).toHaveBeenCalledTimes(2);
  expect(f.save).toHaveBeenLastCalledWith(
    '/restore-state/' + job.id + '/data-accepted',
    Buffer.from(job.id),
    false,
  );
  expect(f.remove).toHaveBeenCalledWith('/restore-live/.verity-recovery-pending', { force: true });
  await expect(initialize({ ...job, phase: 'promoted' }, 'private-key')).rejects.toThrow(
    'Durable acceptance required',
  );
});
