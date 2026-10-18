import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('sandbox toolkit hardening', () => {
  it('rejects an existing runner account with the wrong primary runtime group', async () => {
    const source = await readFile('features/verity-sandbox-toolkit/install.sh', 'utf8');
    expect(source).toContain('cut -d: -f4)" = "$RUNTIME_GID');
    expect(source).toContain('existing verity-runner does not use runtime GID');
  });
});

it('exports Git policy without importing executable user configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verity-git-policy-'));
  try {
    const source = await readFile('features/verity-sandbox-toolkit/install.sh', 'utf8');
    const start = source.indexOf('# Preserve only installer-generated Git policy');
    const end = source.indexOf('# ─── F11.', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const original = join(root, 'original');
    await writeFile(
      original,
      '[core]\n hooksPath = /trusted/hooks\n sshCommand = attacker\n[user]\n signingkey = /trusted/key\n[include]\n path = /untrusted/config\n',
    );
    const policy = source
      .slice(start, end)
      .replaceAll('/etc/verity-agent.gitconfig', join(root, 'agent.gitconfig'))
      .replace('chown root:root', 'true');
    const exported = spawnSync(
      'bash',
      ['-c', 'gc() { git config --file "$ORIGINAL" "$@"; };\n' + policy],
      {
        env: { ...process.env, ORIGINAL: original },
        encoding: 'utf8',
      },
    );
    expect(exported.status, exported.stderr).toBe(0);
    const query = (key: string) =>
      spawnSync('git', ['config', '--file', join(root, 'agent.gitconfig'), '--get', key], {
        encoding: 'utf8',
      });
    expect(query('core.hooksPath').stdout.trim()).toBe('/trusted/hooks');
    expect(query('user.signingkey').stdout.trim()).toBe('/trusted/key');
    expect(query('core.sshCommand').status).toBe(1);
    expect(query('include.path').status).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
