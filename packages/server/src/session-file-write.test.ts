import {
  chmod,
  mkdir,
  open,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const race = vi.hoisted(() => ({ save: false, late: false, captured: '' }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    link: async (source: string, destination: string) => {
      await actual.link(source, destination);
      if (race.late) {
        race.late = false;
        await actual.writeFile(race.captured, 'late agent save');
      }
    },
    rename: async (source: string, destination: string) => {
      await actual.rename(source, destination);
      race.captured = destination;
      if (race.save) {
        race.save = false;
        await actual.writeFile(source, 'agent save');
      }
    },
  };
});
import { openKnowledgeFileSlot } from './session-files.js';
import {
  FILE_HISTORY_DIR,
  recoverFileHistory,
  sessionFileHistory,
} from './session-file-history.js';
import { fileVersion, writeSessionText } from './session-file-write.js';
let dir: string;
afterEach(async () => {
  race.save = false;
  race.late = false;
  if (dir) await rm(dir, { recursive: true, force: true });
});
async function setup() {
  dir = await mkdtemp(join(tmpdir(), 'verity-edit-test-'));
  await writeFile(join(dir, 'a.txt'), 'original');
  return openKnowledgeFileSlot({ root: 'worktree', dir }, 'a.txt');
}

it('preserves mode and retains version backups after saving', async () => {
  const slot = await setup();
  try {
    await chmod(join(dir, 'a.txt'), 0o600);
    await writeSessionText(slot, 'new text', fileVersion(Buffer.from('original')));
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('new text');
    expect((await stat(join(dir, 'a.txt'))).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual([FILE_HISTORY_DIR, 'a.txt']);
  } finally {
    await slot.close();
  }
});

it('does not replace an agent save arriving after source capture', async () => {
  const slot = await setup();
  try {
    race.save = true;
    await expect(
      writeSessionText(slot, 'my edits', fileVersion(Buffer.from('original'))),
    ).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('agent save');
    const staging = (await readdir(join(dir, FILE_HISTORY_DIR)))[0]!;
    expect(await readFile(join(dir, FILE_HISTORY_DIR, staging, 'original'), 'utf8')).toBe(
      'original',
    );
  } finally {
    await slot.close();
  }
});

it('rejects leaf symlinks without changing their target', async () => {
  const slot = await setup();
  try {
    await writeFile(join(dir, 'outside.txt'), 'untouched');
    await rm(join(dir, 'a.txt'));
    await symlink(join(dir, 'outside.txt'), join(dir, 'a.txt'));
    await expect(
      writeSessionText(slot, 'my edits', fileVersion(Buffer.from('untouched'))),
    ).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(dir, 'outside.txt'), 'utf8')).toBe('untouched');
  } finally {
    await slot.close();
  }
});

it('refuses a stale version and restores the source without temporary leftovers', async () => {
  const slot = await setup();
  try {
    await expect(
      writeSessionText(slot, 'my edits', fileVersion(Buffer.from('stale'))),
    ).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('original');
    expect(await readdir(dir)).toEqual([FILE_HISTORY_DIR, 'a.txt']);
  } finally {
    await slot.close();
  }
});

it('does not overwrite an existing file when creating', async () => {
  const slot = await setup();
  try {
    await expect(writeSessionText(slot, 'new file', null)).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('original');
  } finally {
    await slot.close();
  }
});

it('retains late descriptor writes and an immutable version independently', async () => {
  const slot = await setup();
  const descriptor = await open(join(dir, 'a.txt'), 'r+');
  try {
    await writeSessionText(slot, 'editor save', fileVersion(Buffer.from('original')));
    await descriptor.writeFile('late agent save');
    const transaction = (await readdir(join(dir, FILE_HISTORY_DIR)))[0]!;
    const base = join(dir, FILE_HISTORY_DIR, transaction);
    expect(await readFile(join(base, 'original'), 'utf8')).toBe('late agent save');
    expect(await readFile(join(base, 'snapshot'), 'utf8')).toBe('original');
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('editor save');
    await rm(join(dir, 'a.txt'));
    await recoverFileHistory(slot.directoryPath);
    await expect(readFile(join(dir, 'a.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await descriptor.close();
    await slot.close();
  }
});

it('restores an interrupted capture without replacing a newer pathname save', async () => {
  const slot = await setup();
  try {
    const base = join(dir, FILE_HISTORY_DIR, 'save-interrupted');
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'name'), 'a.txt');
    await writeFile(join(base, 'original'), 'recovery');
    await rm(join(dir, 'a.txt'));
    await recoverFileHistory(slot.directoryPath);
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('recovery');
    await writeFile(join(dir, 'a.txt'), 'newer save');
    await recoverFileHistory(slot.directoryPath);
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('newer save');
  } finally {
    await slot.close();
  }
});

it('reports published content as saved even when an old descriptor writes during publication', async () => {
  const slot = await setup();
  try {
    race.late = true;
    const result = await writeSessionText(slot, 'published', fileVersion(Buffer.from('original')));
    expect(result.content).toBe('published');
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('published');
    const transaction = (await readdir(join(dir, FILE_HISTORY_DIR)))[0]!;
    expect(await readFile(join(dir, FILE_HISTORY_DIR, transaction, 'original'), 'utf8')).toBe(
      'late agent save',
    );
    await rm(join(dir, 'a.txt'));
    await recoverFileHistory(slot.directoryPath);
    await expect(readFile(join(dir, 'a.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await slot.close();
  }
});

it('removes disposable history transactions after creates and rejected edits', async () => {
  const slot = await setup();
  try {
    await expect(
      writeSessionText(slot, 'rejected', fileVersion(Buffer.from('stale'))),
    ).rejects.toMatchObject({ status: 409 });
    expect(await readdir(join(dir, FILE_HISTORY_DIR))).toEqual([]);
    await rm(join(dir, 'a.txt'));
    await writeSessionText(slot, 'created', null);
    expect(await readdir(join(dir, FILE_HISTORY_DIR))).toEqual([]);
  } finally {
    await slot.close();
  }
});

it('rejects directory targets without moving their contents', async () => {
  const slot = await setup();
  try {
    await rm(join(dir, 'a.txt'));
    await mkdir(join(dir, 'a.txt'));
    await writeFile(join(dir, 'a.txt', 'child.txt'), 'keep');
    await expect(
      writeSessionText(slot, 'edits', fileVersion(Buffer.from('original'))),
    ).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(dir, 'a.txt', 'child.txt'), 'utf8')).toBe('keep');
    expect(await readdir(dir)).toEqual(['a.txt']);
  } finally {
    await slot.close();
  }
});

it('recovers directory substitution during capture and skips metadata interrupted before creation', async () => {
  const slot = await setup();
  try {
    const history = join(dir, FILE_HISTORY_DIR);
    const transaction = join(history, 'save-directory');
    await mkdir(join(transaction, 'original'), { recursive: true });
    await writeFile(join(transaction, 'name'), 'a.txt');
    await writeFile(join(transaction, 'original', 'child.txt'), 'keep');
    await mkdir(join(history, 'save-empty'));
    await rm(join(dir, 'a.txt'));
    await mkdir(join(dir, 'a.txt'));
    await recoverFileHistory(slot.directoryPath);
    expect(await readFile(join(dir, 'a.txt', 'child.txt'), 'utf8')).toBe('keep');
    expect(await sessionFileHistory(slot.directoryPath, 'a.txt')).toEqual({ versions: [] });
    await rm(join(dir, 'a.txt'), { recursive: true });
    await recoverFileHistory(slot.directoryPath);
    await expect(readFile(join(dir, 'a.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await slot.close();
  }
});
