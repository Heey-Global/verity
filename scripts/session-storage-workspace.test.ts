import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { ProjectRecord, SessionRecord } from '../packages/store/src/index.js';
import { SessionStorage, compareDependencyTrees } from '../packages/server/src/session-storage.js';
import { workspaceDependencyLinks } from '../packages/server/src/dependency-workspace-links.js';
import { fixture as dependencyFixture, env as dependencyEnv } from './dependency-fixture.js';

it('collects helper-activated workspace dependencies and protects custom source links', async () => {
  const f = dependencyFixture();
  for (const root of [f.root, f.worktree]) {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'test', version: '1.0.0', workspaces: ['packages/*'] }),
    );
    mkdirSync(join(root, 'packages', 'source'), { recursive: true });
    writeFileSync(join(root, 'packages', 'source', 'package.json'), '{"name":"source"}');
  }
  const source = join(f.worktree, 'packages', 'source');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'package.json'), '{"name":"source"}');
  writeFileSync(join(source, 'edited.js'), 'session source edits');
  writeFileSync(
    join(f.worktree, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/private': { version: '2.0.0' },
        'node_modules/source': { link: true, resolved: 'packages/source' },
      },
    }),
  );
  const activation = f.run('install');
  expect(activation.status, activation.stderr).toBe(0);
  const session = { sessionId: 's', projectId: 'p', worktree: f.worktree } as SessionRecord;
  const project = { id: 'p', kind: 'github', state: 'active' } as ProjectRecord;
  const now = Date.now();
  const service = new SessionStorage({
    listProjects: async () => [project],
    listSessions: async () => [session],
    activity: async () => now - 4 * 86400000,
    now: () => now,
    root: () => f.root,
    mutate: async (_, __, operation) => operation(),
    withGit: async (_, operation) =>
      operation(async (args) =>
        execFileSync('git', args, { env: dependencyEnv, encoding: 'utf8' }),
      ),
    pr: async () => null,
  });
  service.bind(
    async (_, operation) => ({ ran: true, value: await operation() }),
    () => false,
  );
  await service.runOnce();
  expect(
    service.lastReport?.dependenciesRemoved,
    JSON.stringify(service.lastReport?.blockers),
  ).toContain(join(f.worktree, 'node_modules'));
  expect(readFileSync(join(source, 'edited.js'), 'utf8')).toBe('session source edits');
  const reactivation = f.run('install');
  expect(reactivation.status, reactivation.stderr).toBe(0);
  const custom = join(f.root, 'custom-source');
  mkdirSync(custom);
  writeFileSync(join(custom, 'patch.js'), 'unique custom package');
  rmSync(join(f.worktree, 'node_modules', 'source'));
  symlinkSync(custom, join(f.worktree, 'node_modules', 'source'));
  await service.runOnce();
  expect(existsSync(join(f.worktree, 'node_modules', 'private'))).toBe(true);
  expect(readlinkSync(join(f.worktree, 'node_modules', 'source'))).toBe(custom);
  expect(readFileSync(join(custom, 'patch.js'), 'utf8')).toBe('unique custom package');
  expect(service.lastReport?.recoveryHolds?.count).toBeGreaterThanOrEqual(1);
});

it.each([
  {
    name: 'an internal file dependency outside declared workspaces',
    slot: 'source',
    patterns: ['apps/*'],
  },
  {
    name: 'an alias that workspace restoration would not recreate',
    slot: 'alias',
    patterns: ['packages/*'],
  },
])('holds $name despite matching lock link declarations', async ({ slot, patterns }) => {
  const f = dependencyFixture();
  const shared = join(f.root, 'central');
  mkdirSync(shared);
  for (const root of [f.root, f.worktree, shared]) {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'test', workspaces: patterns }),
    );
    mkdirSync(join(root, 'packages', 'source'), { recursive: true });
    writeFileSync(join(root, 'packages', 'source', 'package.json'), '{"name":"source"}');
    writeFileSync(
      join(root, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          [`node_modules/${slot}`]: { link: true, resolved: 'packages/source' },
        },
      }),
    );
  }
  for (const root of [f.worktree, shared]) {
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    symlinkSync('../packages/source', join(root, 'node_modules', slot));
  }
  const workspaceLinks = await workspaceDependencyLinks(f.worktree, shared, f.root);
  expect(workspaceLinks.size).toBe(0);
  await expect(
    compareDependencyTrees(
      join(f.worktree, 'node_modules'),
      join(shared, 'node_modules'),
      new AbortController().signal,
      {
        local: join(f.worktree, 'node_modules'),
        shared: join(shared, 'node_modules'),
        workspaceLinks,
      },
    ),
  ).rejects.toThrow('different source trees');
});
