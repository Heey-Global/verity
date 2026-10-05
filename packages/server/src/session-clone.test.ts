import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RepositoryHasNoCommitsError } from './worktree.js';
import { assertIndependentSessionClone, createSessionCloneProvisioner } from './session-clone.js';

const git = (path: string, ...args: string[]) =>
  execFileSync('git', ['-C', path, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
let temp: string;
let source: string;
let root: string;
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'verity-session-clone-'));
  source = join(temp, 'source');
  root = join(source, '.verity-sessions');
  mkdirSync(source);
  git(source, 'init', '-b', 'main');
  git(source, 'config', 'user.email', 'test@example.com');
  git(source, 'config', 'user.name', 'Test');
  writeFileSync(join(source, 'file.txt'), 'original\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'initial');
});
afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
});

describe('independent session clones', () => {
  it('owns Git storage and permits commits without mutating sibling or source', async () => {
    const provisioner = createSessionCloneProvisioner({
      repoDir: source,
      worktreeRoot: root,
      baseBranch: 'main',
    });
    const a = await provisioner.add('agent/a');
    const b = await provisioner.add('agent/b');
    const initial = git(source, 'rev-parse', 'HEAD');
    expect(statSync(join(a, '.git')).isDirectory()).toBe(true);
    git(a, 'config', 'user.email', 'test@example.com');
    git(a, 'config', 'user.name', 'Test');
    writeFileSync(join(a, 'file.txt'), 'session a\n');
    git(a, 'add', '.');
    git(a, 'commit', '-m', 'session change');
    git(a, 'worktree', 'prune', '--expire', 'now');
    git(a, 'gc', '--prune=now');
    // Direct metadata writes must never share the sibling's refs or index.
    writeFileSync(join(a, '.git', 'refs', 'heads', 'main'), `${git(a, 'rev-parse', 'HEAD')}\n`);
    expect(git(b, 'rev-parse', 'HEAD')).toBe(initial);
    expect(git(source, 'rev-parse', 'HEAD')).toBe(initial);
    expect(readFileSync(join(b, 'file.txt'), 'utf8')).toBe('original\n');
    expect(readFileSync(join(source, 'file.txt'), 'utf8')).toBe('original\n');
    expect(git(source, 'branch', '--list', 'agent/a')).toBe('');
    await provisioner.remove(a);
    await assertIndependentSessionClone(b);
  });

  it('fetches the latest integration branch and preserves the real origin', async () => {
    const remote = join(temp, 'remote');
    execFileSync('git', ['clone', '--bare', source, remote], { stdio: 'ignore' });
    git(source, 'remote', 'add', 'origin', remote);
    const writer = join(temp, 'writer');
    execFileSync('git', ['clone', remote, writer], { stdio: 'ignore' });
    git(writer, 'config', 'user.email', 'test@example.com');
    git(writer, 'config', 'user.name', 'Test');
    writeFileSync(join(writer, 'file.txt'), 'latest\n');
    git(writer, 'commit', '-am', 'latest');
    git(writer, 'push', 'origin', 'main');
    git(source, 'checkout', '--detach', 'HEAD');
    git(source, 'branch', '-D', 'main');
    const clone = await createSessionCloneProvisioner({
      repoDir: source,
      worktreeRoot: root,
      baseBranch: 'main',
      refreshBase: true,
    }).add('agent/latest');
    expect(git(clone, 'remote', 'get-url', 'origin')).toBe(remote);
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(git(writer, 'rev-parse', 'HEAD'));
    expect(git(clone, 'rev-parse', 'main')).toBe(git(writer, 'rev-parse', 'HEAD'));
    expect(readFileSync(join(source, 'file.txt'), 'utf8')).toBe('original\n');
  });

  it('reports empty repositories without leaving a partial checkout', async () => {
    const empty = join(temp, 'empty');
    mkdirSync(empty);
    git(empty, 'init', '-b', 'main');
    await expect(
      createSessionCloneProvisioner({ repoDir: empty, worktreeRoot: root }).add('agent/empty'),
    ).rejects.toBeInstanceOf(RepositoryHasNoCommitsError);
    expect(() => statSync(join(root, 'agent-empty'))).toThrow();
  });

  it('refuses legacy worktrees and shared alternates', async () => {
    mkdirSync(root);
    const legacy = join(root, 'legacy');
    git(source, 'worktree', 'add', legacy, '-b', 'legacy');
    await expect(assertIndependentSessionClone(legacy)).rejects.toThrow();
    const clone = await createSessionCloneProvisioner({ repoDir: source, worktreeRoot: root }).add(
      'agent/private',
    );
    writeFileSync(
      join(clone, '.git', 'objects', 'info', 'alternates'),
      join(source, '.git', 'objects'),
    );
    await expect(assertIndependentSessionClone(clone)).rejects.toThrow('shared Git storage');
  });

  it('does not remove existing sessions or paths outside its root', async () => {
    const provisioner = createSessionCloneProvisioner({ repoDir: source, worktreeRoot: root });
    const clone = await provisioner.add('agent/a');
    await expect(provisioner.add('agent/a')).rejects.toThrow();
    await assertIndependentSessionClone(clone);
    await expect(provisioner.remove(source)).rejects.toThrow('Invalid');
    symlinkSync(source, join(root, 'link'));
    await expect(provisioner.remove(join(root, 'link'))).rejects.toThrow();
    await expect(provisioner.remove(join(root, 'link', '.git'))).rejects.toThrow();
  });

  it('refuses symlinked Git metadata and proves the guard fails on a broken clone', async () => {
    const clone = await createSessionCloneProvisioner({ repoDir: source, worktreeRoot: root }).add(
      'agent/private',
    );
    await assertIndependentSessionClone(clone);
    rmSync(join(clone, '.git', 'index'));
    symlinkSync(join(source, '.git', 'index'), join(clone, '.git', 'index'));
    await expect(assertIndependentSessionClone(clone)).rejects.toThrow('symlink');
  });

  it('redacts fetch credentials and removes only its failed clone', async () => {
    git(source, 'remote', 'add', 'origin', '/nonexistent');
    const header = 'Authorization: Basic sensitive';
    const provisioner = createSessionCloneProvisioner({
      repoDir: source,
      worktreeRoot: root,
      baseBranch: 'main',
      refreshBase: true,
      fetchAuthHeader: () => Promise.resolve(header),
      git: (args) => {
        if (args.includes('fetch')) return Promise.reject(new Error(header));
        execFileSync('git', [...args], { stdio: 'ignore' });
        return Promise.resolve();
      },
    });
    await expect(provisioner.add('agent/failure')).rejects.toThrow('[redacted]');
    expect(() => statSync(join(root, 'agent-failure'))).toThrow();
    expect(git(source, 'status', '--porcelain')).toBe('');
  });
});
