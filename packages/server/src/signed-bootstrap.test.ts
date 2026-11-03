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
