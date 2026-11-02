import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('rejects unsupported destination relocation before creating a directory or rewriting installer state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-relocation-'));
  const state = join(root, 'state');
  const original = join(root, 'original');
  const target = join(root, 'relocated');
  try {
    await mkdir(state);
    await mkdir(original);
    await writeFile(join(state, 'backup-dir'), original + '\n');
    await writeFile(join(state, 'installation-id'), '11111111-1111-4111-8111-111111111111');
    await writeFile(join(original, '.verity-backup-target'), 'preserve-target');
    const result = promisify(execFile)('bash', [
      '-c',
      `
      set -euo pipefail
      STATE_DIR=$1
      read_state() { if [[ -f $1 ]]; then cat "$1"; fi; }
      die() { printf '%s\\n' "$*" >&2; exit 1; }
      source "$3"
      setup_backup_prerequisites "$2" fixture
    `,
      'backup-relocation',
      state,
      target,
      resolve('deploy/host/verity-backup-prerequisites'),
    ]);
    await expect(result).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('explicit migration'),
    });
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(state, 'backup-dir'), 'utf8')).toBe(original + '\n');
    expect(await readFile(join(state, 'installation-id'), 'utf8')).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(await readFile(join(original, '.verity-backup-target'), 'utf8')).toBe('preserve-target');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
