import { execFileSync } from 'node:child_process';
import {
  existsSync,
  statSync,
  chmodSync,
  symlinkSync,
  readlinkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { assertIndependentSessionClone } from './session-clone.js';
import { migrateLegacySessionClone } from './session-clone-migration.js';

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
let temp: string;
let source: string;
let checkout: string;
let backupRoot: string;
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'verity-migrate-'));
  source = join(temp, 'source');
  checkout = join(temp, 'checkout');
  backupRoot = join(temp, 'backups');
  mkdirSync(source);
  git(source, 'init', '-b', 'main');
  git(source, 'config', 'user.email', 'test@example.com');
  git(source, 'config', 'user.name', 'Test');
  writeFileSync(join(source, 'file'), 'initial\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'initial');
  git(source, 'worktree', 'add', checkout, '-b', 'session');
});
afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
});

it('preserves staged-only objects, unstaged changes, branch and available operation state', async () => {
  writeFileSync(join(checkout, 'file'), 'staged-only blob\n');
  git(checkout, 'add', 'file');
  writeFileSync(join(checkout, 'file'), 'unstaged\n');
  writeFileSync(join(checkout, 'untracked'), 'private\n');
  const admin = git(checkout, 'rev-parse', '--absolute-git-dir');
  const index = readFileSync(join(admin, 'index'));
  const head = git(checkout, 'rev-parse', 'HEAD');
  writeFileSync(join(admin, 'MERGE_HEAD'), `${head}\n`);
  mkdirSync(join(admin, 'rebase-merge'));
  writeFileSync(join(admin, 'rebase-merge', 'orig-head'), `${head}\n`);
  const { backupPath } = await migrateLegacySessionClone({
    checkoutPath: checkout,
    projectRepoPath: source,
    backupRoot,
    stopped: true,
  });
  await assertIndependentSessionClone(checkout);
  expect(git(checkout, 'branch', '--show-current')).toBe('session');
  expect(git(checkout, 'show', ':file')).toBe('staged-only blob');
  expect(readFileSync(join(checkout, 'file'), 'utf8')).toBe('unstaged\n');
  expect(readFileSync(join(checkout, 'untracked'), 'utf8')).toBe('private\n');
  expect(readFileSync(join(checkout, '.git', 'index'))).toEqual(index);
  expect(readFileSync(join(checkout, '.git', 'MERGE_HEAD'), 'utf8')).toBe(`${head}\n`);
  expect(readFileSync(join(checkout, '.git', 'rebase-merge', 'orig-head'), 'utf8')).toBe(
    `${head}\n`,
  );
  expect(backupPath).toBeDefined();
  expect(existsSync(join(backupPath!, 'checkout', 'untracked'))).toBe(true);
  expect(git(source, 'rev-parse', 'HEAD')).toBe(head);
  expect(
    (
      await migrateLegacySessionClone({
        checkoutPath: checkout,
        projectRepoPath: source,
        backupRoot,
        stopped: true,
      })
    ).backupPath,
  ).toBeUndefined();
});

it('refuses running sessions and recursive backup locations without modifying the checkout', async () => {
  const original = readFileSync(join(checkout, '.git'), 'utf8');
  await expect(
    migrateLegacySessionClone({
      checkoutPath: checkout,
      projectRepoPath: source,
      backupRoot,
      stopped: false,
    }),
  ).rejects.toThrow('Stop');
  await expect(
    migrateLegacySessionClone({
      checkoutPath: checkout,
      projectRepoPath: source,
      backupRoot: join(checkout, 'backup'),
      stopped: true,
    }),
  ).rejects.toThrow('outside');
  expect(readFileSync(join(checkout, '.git'), 'utf8')).toBe(original);
});

it('refuses migration when private Git validation fails and retains original link and backup', async () => {
  // An alternate is a shared object dependency; migration must refuse rather than silently retain it.
  mkdirSync(join(source, '.git', 'objects', 'info'), { recursive: true });
  writeFileSync(
    join(source, '.git', 'objects', 'info', 'alternates'),
    join(source, '.git', 'objects'),
  );
  const original = readFileSync(join(checkout, '.git'), 'utf8');
  await expect(
    migrateLegacySessionClone({
      checkoutPath: checkout,
      projectRepoPath: source,
      backupRoot,
      stopped: true,
    }),
  ).rejects.toThrow();
  expect(readFileSync(join(checkout, '.git'), 'utf8')).toBe(original);
});

it('relocates outside the shared project while preserving the original checkout', async () => {
  const original = readFileSync(join(checkout, '.git'), 'utf8');
  writeFileSync(join(checkout, 'untracked'), 'keep\n');
  const destination = join(temp, 'private-sessions', 'session');
  await migrateLegacySessionClone({
    checkoutPath: checkout,
    projectRepoPath: source,
    destinationPath: destination,
    backupRoot,
    stopped: true,
  });
  await assertIndependentSessionClone(destination);
  expect(readFileSync(join(checkout, '.git'), 'utf8')).toBe(original);
  expect(readFileSync(join(destination, 'untracked'), 'utf8')).toBe('keep\n');
  expect(git(destination, 'branch', '--show-current')).toBe('session');
});

it('preserves upstreams, remotes, repository settings and reflog recovery commits', async () => {
  git(source, 'remote', 'add', 'origin', 'https://example.com/project.git');
  git(source, 'remote', 'add', 'backup', 'https://example.com/backup.git');
  git(source, 'config', 'branch.session.remote', 'origin');
  git(source, 'config', 'branch.session.merge', 'refs/heads/session');
  git(source, 'config', 'core.autocrlf', 'false');
  git(source, 'config', 'core.hooksPath', join(source, 'hooks'));
  writeFileSync(join(checkout, 'file'), 'recoverable\n');
  git(checkout, 'commit', '-am', 'recoverable');
  const recoverable = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'reset', '--hard', 'HEAD~1');
  const reflog = git(checkout, 'reflog', 'show', '--format=%H', 'session');
  await migrateLegacySessionClone({
    checkoutPath: checkout,
    projectRepoPath: source,
    backupRoot,
    stopped: true,
  });
  expect(git(checkout, 'config', 'branch.session.remote')).toBe('origin');
  expect(git(checkout, 'config', 'branch.session.merge')).toBe('refs/heads/session');
  expect(git(checkout, 'remote', 'get-url', 'backup')).toBe('https://example.com/backup.git');
  expect(git(checkout, 'config', 'core.autocrlf')).toBe('false');
  expect(() => git(checkout, 'config', 'core.hooksPath')).toThrow();
  expect(git(checkout, 'reflog', 'show', '--format=%H', 'session')).toBe(reflog);
  git(checkout, 'gc', '--prune=now');
  expect(git(checkout, 'show', `${recoverable}:file`)).toBe('recoverable');
});

it.each(['linked', 'independent'])(
  'preserves relative symlink text through backup and private relocation (%s)',
  async (kind) => {
    if (kind === 'independent') {
      git(source, 'worktree', 'remove', checkout);
      execFileSync('git', ['clone', '--no-local', source, checkout], { stdio: 'ignore' });
    }
    symlinkSync('./file', join(checkout, 'link'));
    git(checkout, 'add', 'link');
    git(
      checkout,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'relative link',
    );
    const destination = join(temp, 'private', 'session');
    const migrated = await migrateLegacySessionClone({
      checkoutPath: checkout,
      projectRepoPath: source,
      destinationPath: destination,
      backupRoot,
      stopped: true,
    });
    expect(readlinkSync(join(destination, 'link'))).toBe('./file');
    expect(readlinkSync(join(migrated.backupPath!, 'checkout', 'link'))).toBe('./file');
    expect(git(destination, 'status', '--porcelain')).toBe('');
  },
);

it('rejects initialized submodules before modifying the checkout or recovery artifacts', async () => {
  const sub = join(temp, 'submodule-source');
  mkdirSync(sub);
  git(sub, 'init', '-b', 'main');
  git(sub, 'config', 'user.name', 'Test');
  git(sub, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(sub, 'file'), 'submodule content');
  git(sub, 'add', '.');
  git(sub, 'commit', '-m', 'initial');
  git(checkout, '-c', 'protocol.file.allow=always', 'submodule', 'add', sub, 'nested');
  const link = readFileSync(join(checkout, 'nested', '.git'), 'utf8');
  const destination = join(temp, 'private');
  await expect(
    migrateLegacySessionClone({
      checkoutPath: checkout,
      projectRepoPath: source,
      backupRoot,
      destinationPath: destination,
      stopped: true,
    }),
  ).rejects.toThrow('Initialized submodules require manual recovery');
  expect(existsSync(destination)).toBe(false);
  expect(existsSync(backupRoot)).toBe(false);
  expect(readFileSync(join(checkout, 'nested', '.git'), 'utf8')).toBe(link);
  expect(git(join(checkout, 'nested'), 'show', 'HEAD:file')).toBe('submodule content');
});

it('does not execute a checkout fsmonitor during server-side inspection', async () => {
  const marker = join(temp, 'server-hook-ran');
  const hook = join(temp, 'fsmonitor');
  writeFileSync(hook, `#!/bin/sh\nprintf compromised > '${marker}'\n`);
  chmodSync(hook, 0o755);
  git(checkout, 'config', 'core.fsmonitor', hook);
  await migrateLegacySessionClone({
    checkoutPath: checkout,
    projectRepoPath: source,
    backupRoot,
    stopped: true,
  });
  expect(existsSync(marker)).toBe(false);
});

it('migrates indexes whose listing exceeds the default child-process output buffer', async () => {
  const blob = git(checkout, 'rev-parse', 'HEAD:file');
  const entries = Array.from(
    { length: 16000 },
    (_, index) =>
      `100644 ${blob}\tlarge-index/${String(index).padStart(6, '0')}-${'x'.repeat(80)}\n`,
  ).join('');
  execFileSync('git', ['-C', checkout, 'update-index', '--index-info'], { input: entries });
  const admin = git(checkout, 'rev-parse', '--absolute-git-dir');
  expect(statSync(join(admin, 'index')).size).toBeGreaterThan(1024 * 1024);
  const index = readFileSync(join(admin, 'index'));
  await migrateLegacySessionClone({
    checkoutPath: checkout,
    projectRepoPath: source,
    backupRoot,
    stopped: true,
  });
  expect(readFileSync(join(checkout, '.git', 'index'))).toEqual(index);
});

it('rejects forged administrative and common-directory pointers across projects', async () => {
  const foreign = join(temp, 'foreign');
  const foreignCheckout = join(temp, 'foreign-checkout');
  mkdirSync(foreign);
  git(foreign, 'init', '-b', 'main');
  git(
    foreign,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--allow-empty',
    '-m',
    'private',
  );
  git(foreign, 'worktree', 'add', foreignCheckout, '-b', 'private-session');
  const originalLink = readFileSync(join(checkout, '.git'), 'utf8');
  const admin = git(checkout, 'rev-parse', '--absolute-git-dir');
  const originalCommon = readFileSync(join(admin, 'commondir'), 'utf8');
  writeFileSync(join(checkout, '.git'), readFileSync(join(foreignCheckout, '.git')));
  const options = {
    checkoutPath: checkout,
    projectRepoPath: source,
    backupRoot,
    destinationPath: join(temp, 'private'),
    stopped: true,
  };
  await expect(migrateLegacySessionClone(options)).rejects.toThrow('recorded project');
  writeFileSync(join(checkout, '.git'), originalLink);
  writeFileSync(join(admin, 'commondir'), join(foreign, '.git'));
  await expect(migrateLegacySessionClone(options)).rejects.toThrow('this session');
  writeFileSync(join(admin, 'commondir'), originalCommon);
  expect(existsSync(backupRoot)).toBe(false);
  expect(existsSync(options.destinationPath)).toBe(false);
  expect(readFileSync(join(checkout, '.git'), 'utf8')).toBe(originalLink);
});
