import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NetworkShareError, contentVersion } from './network-share-smb.js';
import { FAKE_TARGET, createFakeShare, type FakeShare } from './network-share-smb.test-helper.js';

const original = Buffer.from('original text\n');

// The commands of a file delete, in order: 1 allinfo, 2 rename the file aside,
// 3 get the moved file, 4 del it. A restore renames it back.
const MOVE_ASIDE = 2;
const DOWNLOAD = 3;
const REMOVE = 4;

let fake: FakeShare;

beforeEach(() => {
  fake = createFakeShare();
  writeFileSync(join(fake.root, 'notes.md'), original);
  mkdirSync(join(fake.root, 'Reviews'));
  writeFileSync(join(fake.root, 'Reviews', 'q1.md'), 'q1\n');
  mkdirSync(join(fake.root, 'Empty'));
});

afterEach(() => {
  fake.remove();
});

async function code(work: Promise<unknown>): Promise<string> {
  const error = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(NetworkShareError);
  return (error as NetworkShareError).code;
}

/** The untouched share without one entry. */
const without = (name: string) =>
  Object.fromEntries(Object.entries(untouched).filter(([key]) => key !== name));

const untouched = {
  'notes.md': 'original text\n',
  Reviews: '/',
  'Reviews/q1.md': 'q1\n',
  Empty: '/',
};

// A delete must never take a version the agent did not read, and when it is
// cut short the file's bytes stay on the share, with the agent told where.
describe('deleting a file on a share', () => {
  const remove = (
    plan = [] as Parameters<FakeShare['client']>[0],
    version = contentVersion(original),
  ) => fake.client(plan).deleteFile(FAKE_TARGET, 'notes.md', version);

  it('deletes the version that was read and leaves nothing behind', async () => {
    await remove();
    expect(fake.entries()).toEqual(without('notes.md'));
  });

  it('puts the file back when its content changed since it was read', async () => {
    expect(await code(remove([], contentVersion(Buffer.from('older'))))).toBe('conflict');
    expect(fake.entries()).toEqual(untouched);
  });

  it('puts the file back when the connection drops before the delete', async () => {
    expect(await code(remove([{ at: REMOVE, drop: 'before' }]))).toBe('unreachable');
    expect(fake.entries()).toEqual(untouched);
  });

  it('keeps a file created meanwhile and the original under a hidden name', async () => {
    const error = await code(
      remove(
        [{ at: DOWNLOAD, create: 'notes.md', content: 'theirs\n' }],
        contentVersion(Buffer.from('older')),
      ),
    );
    expect(error).toBe('restore_failed');
    expect(fake.entries()).toEqual({
      ...untouched,
      'notes.md': 'theirs\n',
      old: 'original text\n',
    });
  });

  it('says the original may be hidden when the share stays out of reach', async () => {
    expect(await code(remove([{ at: MOVE_ASIDE, drop: 'after', stayDown: true }]))).toBe(
      'interrupted',
    );
    expect(fake.entries()).toEqual({ ...without('notes.md'), old: 'original text\n' });
  });

  it('refuses a folder', async () => {
    expect(
      await code(fake.client().deleteFile(FAKE_TARGET, 'Reviews', contentVersion(original))),
    ).toBe('not_a_file');
    expect(fake.entries()).toEqual(untouched);
  });
});

describe('folders and names on a share', () => {
  it('creates a folder but never over an existing name', async () => {
    await fake.client().createFolder(FAKE_TARGET, 'Reviews/2026');
    expect(fake.entries()['Reviews/2026']).toBe('/');
    expect(await code(fake.client().createFolder(FAKE_TARGET, 'notes.md'))).toBe('already_exists');
  });

  it('deletes only empty folders', async () => {
    await fake.client().deleteFolder(FAKE_TARGET, 'Empty');
    expect(await code(fake.client().deleteFolder(FAKE_TARGET, 'Reviews'))).toBe('not_empty');
    expect(await code(fake.client().deleteFolder(FAKE_TARGET, 'notes.md'))).toBe('not_a_folder');
    expect(fake.entries()).toEqual(without('Empty'));
  });

  it('moves a folder with its contents and never replaces a name', async () => {
    await fake.client().rename(FAKE_TARGET, 'folder', 'Reviews', 'Empty/Reviews');
    expect(fake.entries()['Empty/Reviews/q1.md']).toBe('q1\n');
    expect(
      await code(fake.client().rename(FAKE_TARGET, 'file', 'notes.md', 'Empty/Reviews/q1.md')),
    ).toBe('already_exists');
    expect(fake.entries()['notes.md']).toBe('original text\n');
  });

  // The card named a file or a folder; whatever else sits at the path now must
  // not be moved under that approval.
  it('refuses an item of another kind than the one approved', async () => {
    expect(await code(fake.client().rename(FAKE_TARGET, 'folder', 'notes.md', 'x.md'))).toBe(
      'not_a_folder',
    );
    expect(await code(fake.client().rename(FAKE_TARGET, 'file', 'Reviews', 'Old'))).toBe(
      'not_a_file',
    );
    expect(fake.entries()).toEqual(untouched);
  });
});
