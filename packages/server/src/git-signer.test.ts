import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GitSignError,
  resolveSigningPrivateKey,
  signGitPayload,
  type SshSignSpawner,
} from './git-signer.js';

// A fake `ssh-keygen -Y sign`: asserts the broker wrote the private key at 0600,
// then produces a `<payload>.sig` the way the real binary would. The real
// ssh-keygen crypto round-trip (sign → verify against allowed_signers) is proven
// separately; this suite covers the module's orchestration + guards without
// depending on the binary in CI (matching signing-key.ts's injected-fake style).
function fakeSigner(): { spawn: SshSignSpawner; calls: Array<{ namespace: string }> } {
  const calls: Array<{ namespace: string }> = [];
  const spawn: SshSignSpawner = ({ keyPath, namespace, payloadPath }) => {
    calls.push({ namespace });
    // The broker must hand ssh-keygen a real 0600 key file.
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(keyPath, 'utf8')).toContain('PRIVATE KEY');
    writeFileSync(`${payloadPath}.sig`, `-----BEGIN SSH SIGNATURE-----\nsig-for:${namespace}\n`);
    return Promise.resolve();
  };
  return { spawn, calls };
}

const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----';

describe('signGitPayload', () => {
  it('signs a git payload and returns the armored signature', async () => {
    const { spawn, calls } = fakeSigner();
    const sig = await signGitPayload(KEY, Buffer.from('commit payload'), 'git', spawn);
    expect(sig).toContain('BEGIN SSH SIGNATURE');
    expect(sig).toContain('sig-for:git');
    expect(calls).toEqual([{ namespace: 'git' }]);
  });

  it("refuses any namespace other than 'git' (no signing oracle for other uses)", async () => {
    const { spawn, calls } = fakeSigner();
    await expect(signGitPayload(KEY, Buffer.from('x'), 'ssh', spawn)).rejects.toBeInstanceOf(
      GitSignError,
    );
    // Rejected BEFORE spawning — the key is never even written for a bad namespace.
    expect(calls).toEqual([]);
  });

  it('refuses when no signing key is configured', async () => {
    const { spawn } = fakeSigner();
    await expect(signGitPayload('   ', Buffer.from('x'), 'git', spawn)).rejects.toBeInstanceOf(
      GitSignError,
    );
  });

  it('wipes the temp key material even when the signer throws', async () => {
    let seenKeyPath = '';
    const spawn: SshSignSpawner = ({ keyPath }) => {
      seenKeyPath = keyPath;
      return Promise.reject(new Error('ssh-keygen blew up'));
    };
    await expect(signGitPayload(KEY, Buffer.from('x'), 'git', spawn)).rejects.toThrow();
    expect(seenKeyPath.length).toBeGreaterThan(0);
    expect(existsSync(seenKeyPath)).toBe(false);
  });
});

describe('resolveSigningPrivateKey', () => {
  const neverRead = (): string => {
    throw new Error('should not read the file');
  };

  it('prefers the DB-stored key contents and never touches the path', () => {
    const key = resolveSigningPrivateKey(
      { gitSshPrivateKey: KEY, gitSshPrivateKeyPath: '/some/path' },
      neverRead,
    );
    expect(key).toBe(KEY);
  });

  it('falls back to reading the file at gitSshPrivateKeyPath when contents are empty', () => {
    const reads: string[] = [];
    const key = resolveSigningPrivateKey(
      { gitSshPrivateKey: null, gitSshPrivateKeyPath: '/data/dev/.shared/github/id_ed25519' },
      (path) => {
        reads.push(path);
        return KEY;
      },
    );
    expect(key).toBe(KEY);
    expect(reads).toEqual(['/data/dev/.shared/github/id_ed25519']);
  });

  it('treats a blank/whitespace contents value as absent and falls through to the path', () => {
    const key = resolveSigningPrivateKey(
      { gitSshPrivateKey: '   ', gitSshPrivateKeyPath: '/p' },
      () => KEY,
    );
    expect(key).toBe(KEY);
  });

  it('returns null when neither contents nor path yield a key', () => {
    expect(resolveSigningPrivateKey(null, neverRead)).toBeNull();
    expect(resolveSigningPrivateKey({ gitSshPrivateKey: null }, neverRead)).toBeNull();
    expect(resolveSigningPrivateKey({ gitSshPrivateKeyPath: '/p' }, () => '   ')).toBeNull();
  });

  it('returns null (not throw) when the key file is unreadable', () => {
    const key = resolveSigningPrivateKey({ gitSshPrivateKeyPath: '/missing' }, () => {
      throw new Error('ENOENT');
    });
    expect(key).toBeNull();
  });
});
