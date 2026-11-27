import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { createProvisioner, fakeDocker, fakeGit } from './provisioner.test-helper.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
});

it('repairs an existing clone under the repository’s new GitHub name without moving it', async () => {
  await ctx.store.upsertProject({
    id: 'p',
    owner: 'heey-global',
    repo: 'deep-ocr',
    containerName: 'verity-heey-global-deep-ocr',
    state: 'failed',
    overviewVisible: true,
  });
  await ctx.store.githubRepositories.reconcile({
    requestedOwner: 'heey-global',
    requestedRepo: 'deep-ocr',
    id: '4242',
    owner: 'heey-global',
    repo: 'deep-ocr',
  });
  const clone = '/srv/verity-dev/heey-global-deep-ocr';
  const { runner: git, calls } = fakeGit([
    { match: /remote get-url origin/, stdout: 'https://github.com/heey-global/deep-ocr\n' },
    { match: /remote set-url origin/ },
    { match: /fetch origin/ },
    { match: /reset --hard origin\/main/ },
    { match: /symbolic-ref --short refs\/remotes\/origin\/HEAD/, stdout: 'origin/main' },
  ]);
  const { client: docker } = fakeDocker();
  const provisioner = createProvisioner({
    store: ctx.store,
    db: ctx.db,
    docker,
    // The real mint scopes by the recorded ID and records the name GitHub reports.
    projectTokenMint: async () => {
      await ctx.store.githubRepositories.reconcile({
        requestedOwner: 'heey-global',
        requestedRepo: 'deep-ocr',
        id: '4242',
        owner: 'heey-global',
        repo: 'ocr-engine',
      });
      return 'tok';
    },
    defaultImageRef: 'default',
    hostCloneRoot: '/srv/verity-dev/',
    git,
    isDirectory: (path: string) => path === clone,
  });
  (provisioner as unknown as { isRepoDir: () => boolean }).isRepoDir = () => true;

  await provisioner.provision('p');

  const url = 'https://github.com/heey-global/ocr-engine';
  const joined = calls.map(({ args }) => args.join(' '));
  expect(joined.some((call) => call.endsWith(`ls-remote --heads ${url}`))).toBe(true);
  // The clone stays where sessions persisted it; only its `origin` follows.
  expect(joined).toContain(`-C ${clone} remote set-url origin ${url}`);
  expect(joined.some((call) => call.includes(' clone '))).toBe(false);
  expect(joined.findIndex((call) => call.includes('remote set-url'))).toBeLessThan(
    joined.findIndex((call) => call.includes('fetch origin')),
  );
  expect(await ctx.store.getProject('p')).toMatchObject({
    id: 'p',
    repo: 'ocr-engine',
    cloneDir: 'heey-global-deep-ocr',
    containerName: 'verity-heey-global-deep-ocr',
  });
});
