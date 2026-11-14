import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CloneConfigGit,
  defaultCloneConfigGit,
  inspectCloneWorktreeConfig,
  removeSessionWorktreeConfig,
  reportCloneWorktreeConfigs,
} from './clone-config-guard.js';

const hermetic = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', env: hermetic, cwd: '/' });
}

let root: string;
let clone: string;
let config: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clone-guard-'));
  clone = join(root, 'owner-repo');
  git('init', '-q', '-b', 'main', clone);
  config = join(clone, '.git', 'config');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const setWorktree = (value: string, file = config): void => {
  git('config', '--file', file, '--add', 'core.worktree', value);
};

describe('inspectCloneWorktreeConfig', () => {
  it('is clean without the key, for the clone root itself, and for the Sandbox mount root', async () => {
    expect(await inspectCloneWorktreeConfig(clone, defaultCloneConfigGit)).toEqual({
      kind: 'clean',
    });
    setWorktree(clone);
    expect((await inspectCloneWorktreeConfig(clone, defaultCloneConfigGit)).kind).toBe('clean');
    git('config', '--file', config, 'core.worktree', '/work');
    expect((await inspectCloneWorktreeConfig(clone, defaultCloneConfigGit)).kind).toBe('clean');
  });

  // The incident value: a session worktree as the Sandbox sees it.
  it.each([
    '/work/.verity-sessions/agent-c9bd8649',
    '/work/.verity-sessions/agent-c9bd8649/',
    '../.verity-sessions/agent-x', // relative to .git, as git resolves it
  ])('reports %s as session contamination', async (value) => {
    setWorktree(value);
    expect(await inspectCloneWorktreeConfig(clone, defaultCloneConfigGit)).toEqual({
      kind: 'session-contamination',
      file: config,
      value,
    });
  });

  it('reports the host-side session path the same way', async () => {
    const value = join(clone, '.verity-sessions', 'agent-x');
    setWorktree(value);
    expect((await inspectCloneWorktreeConfig(clone, defaultCloneConfigGit)).kind).toBe(
      'session-contamination',
    );
  });

  // Anything Verity cannot prove is a session path must never be removed automatically.
  it.each([
    ['/srv/elsewhere'],
    ['/work/.verity-sessions'],
    ['/work/.verity-sessions/agent-x/sub'],
    ['/work/.verity-sessions/agent-x/..'],
    ['/work/other'],
  ])('treats %s as unknown', async (value) => {
    setWorktree(value);
    const finding = await inspectCloneWorktreeConfig(clone, defaultCloneConfigGit);
    expect(finding).toMatchObject({ kind: 'unknown', file: config, values: [value] });
  });

  it('treats several values as unknown, even if each one is a session path', async () => {
    setWorktree('/work/.verity-sessions/a');
    setWorktree('/work/.verity-sessions/b');
    expect(await inspectCloneWorktreeConfig(clone, defaultCloneConfigGit)).toMatchObject({
      kind: 'unknown',
      reason: expect.stringContaining('more than once'),
    });
  });

  it('refuses a symlinked config without reading through it', async () => {
    const elsewhere = join(root, 'elsewhere-config');
    writeFileSync(elsewhere, '[core]\n\tworktree = /work/.verity-sessions/agent-x\n');
    rmSync(config);
    symlinkSync(elsewhere, config);
    expect(await inspectCloneWorktreeConfig(clone, defaultCloneConfigGit)).toMatchObject({
      kind: 'unknown',
      reason: expect.stringContaining('not a regular file'),
    });
  });

  it('reads config.worktree only when extensions.worktreeConfig makes git read it', async () => {
    const perWorktree = join(clone, '.git', 'config.worktree');
    writeFileSync(perWorktree, '[core]\n\tworktree = /work/.verity-sessions/agent-x\n');
    expect((await inspectCloneWorktreeConfig(clone, defaultCloneConfigGit)).kind).toBe('clean');
    git('config', '--file', config, 'extensions.worktreeConfig', 'true');
    expect(await inspectCloneWorktreeConfig(clone, defaultCloneConfigGit)).toEqual({
      kind: 'session-contamination',
      file: perWorktree,
      value: '/work/.verity-sessions/agent-x',
    });
  });

  it('asks git nothing for a config that never mentions the key', async () => {
    const calls: string[][] = [];
    const spy: CloneConfigGit = async (args) => {
      calls.push([...args]);
      return defaultCloneConfigGit(args);
    };
    await inspectCloneWorktreeConfig(clone, spy);
    expect(calls).toEqual([]);
  });
});

describe('removeSessionWorktreeConfig', () => {
  it('backs the file up privately, then removes only that one key', async () => {
    git('config', '--file', config, 'user.name', 'Kept');
    setWorktree('/work/.verity-sessions/agent-x');
    const before = readFileSync(config);
    const finding = await inspectCloneWorktreeConfig(clone, defaultCloneConfigGit);
    if (finding.kind !== 'session-contamination') throw new Error(finding.kind);
    const backups = join(root, 'backups');

    const repair = await removeSessionWorktreeConfig(
      finding,
      backups,
      'project/1',
      defaultCloneConfigGit,
      () => new Date('2026-11-14T19:16:37.000Z'),
    );

    expect(repair.previousValue).toBe('/work/.verity-sessions/agent-x');
    expect(repair.backupPath).toBe(join(backups, 'project_1-2026-11-14T19-16-37-000Z-config'));
    expect(readFileSync(repair.backupPath)).toEqual(before);
    expect(statSync(repair.backupPath).mode & 0o777).toBe(0o600);
    expect(statSync(backups).mode & 0o777).toBe(0o700);
    expect(git('config', '--file', config, '--get', 'user.name').trim()).toBe('Kept');
    expect(await inspectCloneWorktreeConfig(clone, defaultCloneConfigGit)).toEqual({
      kind: 'clean',
    });
  });

  it('leaves a value that changed after inspection in place', async () => {
    setWorktree('/work/.verity-sessions/agent-x');
    const finding = await inspectCloneWorktreeConfig(clone, defaultCloneConfigGit);
    if (finding.kind !== 'session-contamination') throw new Error(finding.kind);
    git('config', '--file', config, 'core.worktree', '/srv/changed-meanwhile');

    await expect(
      removeSessionWorktreeConfig(finding, join(root, 'b'), 'p', defaultCloneConfigGit),
    ).rejects.toThrow();
    expect(git('config', '--file', config, '--get', 'core.worktree').trim()).toBe(
      '/srv/changed-meanwhile',
    );
  });
});

describe('reportCloneWorktreeConfigs', () => {
  it('reports each affected clone and changes none of them', async () => {
    const other = join(root, 'other-repo');
    git('init', '-q', other);
    mkdirSync(join(root, 'not-a-repo'));
    setWorktree('/work/.verity-sessions/agent-x');
    const before = readFileSync(config, 'utf8');
    const reports: string[] = [];

    await reportCloneWorktreeConfigs(root, defaultCloneConfigGit, (path, message) =>
      reports.push(`${path}: ${message}`),
    );

    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain(clone);
    expect(reports[0]).toContain('/work/.verity-sessions/agent-x');
    expect(readFileSync(config, 'utf8')).toBe(before);
    expect(readdirSync(root).sort()).toEqual(['not-a-repo', 'other-repo', 'owner-repo']);
  });
});
