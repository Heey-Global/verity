import { mkdtemp, mkdir, open, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FILE_HISTORY_DIR, pruneFileHistory, sessionFileHistory } from './session-file-history.js';
import { fileVersion, writeSessionText } from './session-file-write.js';
import { openKnowledgeFileSlot } from './session-files.js';

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'verity-retention-'));
  directories.push(dir);
  return dir;
}
it('keeps ten snapshots per file while retaining originals, pending records and other files', async () => {
  const dir = await directory();
  for (let i = 0; i < 13; i++) {
    const transaction = join(dir, FILE_HISTORY_DIR, `save-${i.toString().padStart(2, '0')}`);
    await mkdir(transaction, { recursive: true });
    await writeFile(join(transaction, 'name'), 'a.md');
    await writeFile(join(transaction, 'snapshot'), `version ${i}`);
    await writeFile(join(transaction, 'original'), `original ${i}`);
    await writeFile(join(transaction, 'complete'), '');
    await utimes(join(transaction, 'snapshot'), i + 1, i + 1);
  }
  for (const [name, source] of [
    ['save-pending', 'a.md'],
    ['save-other', 'b.md'],
  ]) {
    const transaction = join(dir, FILE_HISTORY_DIR, name!);
    await mkdir(transaction);
    await writeFile(join(transaction, 'name'), source!);
    await writeFile(join(transaction, 'snapshot'), 'protected');
    if (source === 'b.md') await writeFile(join(transaction, 'complete'), '');
  }
  const original = await open(join(dir, FILE_HISTORY_DIR, 'save-00', 'original'), 'r+');
  try {
    await pruneFileHistory(dir, 'a.md');
    for (let i = 0; i < 13; i++) {
      const base = join(dir, FILE_HISTORY_DIR, `save-${i.toString().padStart(2, '0')}`);
      expect((await readdir(base)).includes('snapshot')).toBe(i >= 3);
      expect(await readFile(join(base, 'original'), 'utf8')).toBe(`original ${i}`);
    }
    await original.writeFile('late write');
    expect(await readFile(join(dir, FILE_HISTORY_DIR, 'save-00', 'original'), 'utf8')).toBe(
      'late write',
    );
    for (const name of ['save-pending', 'save-other'])
      expect(await readFile(join(dir, FILE_HISTORY_DIR, name, 'snapshot'), 'utf8')).toBe(
        'protected',
      );
    await pruneFileHistory(dir, 'a.md');
  } finally {
    await original.close();
  }
});
it('prunes automatically after successful saves and leaves retained versions restorable', async () => {
  const dir = await directory();
  await writeFile(join(dir, 'a.md'), 'version 0');
  const slot = await openKnowledgeFileSlot({ root: 'worktree', dir }, 'a.md');
  try {
    for (let i = 1; i <= 12; i++) {
      await writeSessionText(slot, `version ${i}`, fileVersion(Buffer.from(`version ${i - 1}`)));
    }
    const history = await sessionFileHistory(dir, 'a.md');
    const snapshots = history.versions!.filter((version) => version.kind === 'snapshot');
    expect(snapshots).toHaveLength(10);
    expect(history.versions!.filter((version) => version.kind === 'original')).toHaveLength(12);
    const contents = await Promise.all(
      snapshots.map((version) => sessionFileHistory(dir, 'a.md', version.id)),
    );
    expect(contents.map((version) => version.content).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `version ${i + 2}`).sort(),
    );
  } finally {
    await slot.close();
  }
});
