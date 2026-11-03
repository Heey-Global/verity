import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createSignedEmptyCommit } from './signed-bootstrap.js';
import type { GitRunner } from './provisioner.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const hasUser = (() => {
  try {
    userInfo();
    return true;
  } catch {
    return false;
  }
})();
it.skipIf(!hasUser)(
  'creates a verifiable initial commit and refuses to replace existing history',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'signed-bootstrap-test-'));
    roots.push(root);
    const key = join(root, 'key');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
    execFileSync('git', ['init', '-q', root]);
    const git: GitRunner = async (args) => ({
      stdout: execFileSync('git', [...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
      stderr: '',
    });
    const identity = {
      privateKey: readFileSync(key, 'utf8'),
      committerName: 'Test',
      committerEmail: 'test@example.com',
    };
    await createSignedEmptyCommit(git, root, identity);
    const allowed = join(root, 'allowed');
    writeFileSync(allowed, `test@example.com ${readFileSync(`${key}.pub`, 'utf8')}`);
    const run = (...args: string[]) =>
      execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    expect(run('-c', `gpg.ssh.allowedSignersFile=${allowed}`, 'log', '-1', '--format=%G?')).toBe(
      'G',
    );
    expect(run('log', '-1', '--format=%ce')).toBe(identity.committerEmail);
    expect(run('ls-tree', 'HEAD')).toBe('');
    const head = run('rev-parse', 'HEAD');
    await expect(createSignedEmptyCommit(git, root, identity)).rejects.toThrow();
    expect(run('rev-parse', 'HEAD')).toBe(head);
  },
);
it('refuses identity header injection before running Git or signing', async () => {
  const git: GitRunner = async () => {
    throw new Error('must not execute');
  };
  await expect(
    createSignedEmptyCommit(git, '/unused', {
      privateKey: 'unused',
      committerName: 'name\nparent malicious',
      committerEmail: 'a@b.c',
    }),
  ).rejects.toThrow('Invalid Git signing identity');
});

it('never runs reference hooks when installing a signed bootstrap or merge commit', async () => {
  const { createSignedMergeCommit } = await import('./signed-bootstrap.js');
  const root = mkdtempSync(join(tmpdir(), 'signed-hooks-'));
  roots.push(root);
  const run = (...args: string[]) =>
    execFileSync(
      'git',
      ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  run('config', 'core.hooksPath', join(root, '.git', 'hooks'));
  const hook = join(root, '.git', 'hooks', 'reference-transaction');
  writeFileSync(hook, '#!/bin/sh\nprintf executed > "$0.ran"\n', { mode: 0o755 });
  const git: GitRunner = async (args) => ({
    stdout: execFileSync('git', [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    stderr: '',
  });
  const spawn = async ({ payloadPath }: { payloadPath: string }) => {
    writeFileSync(
      `${payloadPath}.sig`,
      '-----BEGIN SSH SIGNATURE-----\nfixture\n-----END SSH SIGNATURE-----\n',
    );
  };
  const identity = {
    privateKey: 'fixture',
    committerName: 'Signer',
    committerEmail: 'signer@example.com',
  };
  await createSignedEmptyCommit(git, root, identity, spawn);
  expect(() => readFileSync(`${hook}.ran`)).toThrow();
  const first = run('rev-parse', 'HEAD');
  run('-c', 'core.hooksPath=/dev/null', 'checkout', '-qb', 'other');
  writeFileSync(join(root, 'file.txt'), 'incoming');
  run('add', 'file.txt');
  run('-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'incoming');
  const other = run('rev-parse', 'HEAD');
  run('-c', 'core.hooksPath=/dev/null', 'checkout', '-q', 'main');
  run('-c', 'core.hooksPath=/dev/null', 'merge', '--no-ff', '--no-commit', 'other');
  await createSignedMergeCommit(git, root, identity, spawn);
  expect(() => readFileSync(`${hook}.ran`)).toThrow();
  expect(run('show', '-s', '--format=%P', 'HEAD')).toBe(`${first} ${other}`);
  expect(run('cat-file', '-p', 'HEAD')).toContain('gpgsig -----BEGIN SSH SIGNATURE-----');
  expect(() => run('rev-parse', '--verify', 'MERGE_HEAD')).toThrow();
});
