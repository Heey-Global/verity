import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { saveQAReport } from './qa-report.js';
it('creates a new bounded report and refuses a symlinked document root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qa-report-'));
  const id = '12345678-1234-1234-1234-123456789abc';
  try {
    const result = await saveQAReport(
      root,
      'p',
      id,
      { complete: false, groups: [] },
      async () => {},
    );
    expect(await readFile(join(root, 'knowledge', 'p', result.path), 'utf8')).toContain(
      '"complete": false',
    );
    await expect(saveQAReport(root, 'p', id, { complete: true }, async () => {})).rejects.toThrow();
    await mkdir(join(root, 'knowledge', 'q'), { recursive: true });
    await mkdir(join(root, 'outside'));
    await symlink(join(root, 'outside'), join(root, 'knowledge', 'q', 'insights'));
    await expect(saveQAReport(root, 'q', id, {}, async () => {})).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
