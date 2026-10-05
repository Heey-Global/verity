import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    (await migrateLegacySessionClone({ checkoutPath: checkout, backupRoot, stopped: true }))
      .backupPath,
  ).toBeUndefined();
});

it('refuses running sessions and recursive backup locations without modifying the checkout', async () => {
  const original = readFileSync(join(checkout, '.git'), 'utf8');
  await expect(
    migrateLegacySessionClone({ checkoutPath: checkout, backupRoot, stopped: false }),
  ).rejects.toThrow('Stop');
  await expect(
    migrateLegacySessionClone({
      checkoutPath: checkout,
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
    migrateLegacySessionClone({ checkoutPath: checkout, backupRoot, stopped: true }),
  ).rejects.toThrow();
  expect(readFileSync(join(checkout, '.git'), 'utf8')).toBe(original);
});

it('relocates outside the shared project while preserving the original checkout', async () => {
  const original = readFileSync(join(checkout, '.git'), 'utf8');
  writeFileSync(join(checkout, 'untracked'), 'keep\n');
  const destination = join(temp, 'private-sessions', 'session');
  await migrateLegacySessionClone({
    checkoutPath: checkout,
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
  await migrateLegacySessionClone({ checkoutPath: checkout, backupRoot, stopped: true });
  expect(git(checkout, 'config', 'branch.session.remote')).toBe('origin');
  expect(git(checkout, 'config', 'branch.session.merge')).toBe('refs/heads/session');
  expect(git(checkout, 'remote', 'get-url', 'backup')).toBe('https://example.com/backup.git');
  expect(git(checkout, 'config', 'core.autocrlf')).toBe('false');
  expect(() => git(checkout, 'config', 'core.hooksPath')).toThrow();
  expect(git(checkout, 'reflog', 'show', '--format=%H', 'session')).toBe(reflog);
  git(checkout, 'gc', '--prune=now');
  expect(git(checkout, 'show', `${recoverable}:file`)).toBe('recoverable');
});
