import { afterEach, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
  symlink,
  open,
  appendFile,
  truncate,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentWorkspace } from './document-workspace.js';
import { sessionFileHistory } from './session-file-history.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'documents-'));
  roots.push(root);
  const documents = join(root, 'knowledge', 'insights');
  await mkdir(documents, { recursive: true });
  const a = new DocumentWorkspace(documents, join(root, 'a'), join(root, 'state-a'));
  const b = new DocumentWorkspace(documents, join(root, 'b'), join(root, 'state-b'));
  return { root, documents, a, b };
}
it('publishes independent files from parallel views and refreshes unchanged files', async () => {
  const { documents, a, b } = await fixture();
  await writeFile(join(documents, 'offer.md'), 'base');
  await Promise.all([a.prepare(), b.prepare()]);
  await writeFile(join(a.view, 'offer.md'), 'a');
  await writeFile(join(b.view, 'other.md'), 'b');
  await Promise.all([a.publish(), b.publish()]);
  await b.prepare();
  expect(await readFile(join(b.view, 'offer.md'), 'utf8')).toBe('a');
  expect(await readFile(join(documents, 'other.md'), 'utf8')).toBe('b');
  expect((await sessionFileHistory(documents, 'offer.md')).versions).toHaveLength(1);
});
it('retains both concurrent binary edits and does not duplicate conflicts on retry', async () => {
  const { documents, a, b } = await fixture();
  await writeFile(join(documents, 'offer.bin'), Buffer.from([0, 1]));
  await Promise.all([a.prepare(), b.prepare()]);
  await writeFile(join(a.view, 'offer.bin'), Buffer.from([0, 2]));
  await writeFile(join(b.view, 'offer.bin'), Buffer.from([0, 3]));
  await a.publish();
  const result = await b.publish();
  expect(result.conflicts).toHaveLength(1);
  expect(await readFile(join(documents, 'offer.bin'))).toEqual(Buffer.from([0, 2]));
  expect(
    await readFile(join(documents, result.conflicts[0]!, '..', 'proposed', 'offer.bin')),
  ).toEqual(Buffer.from([0, 3]));
  await b.publish();
  expect(await readdir(join(documents, 'Conflicts'))).toHaveLength(1);
  await b.prepare();
  expect(await readFile(join(b.view, 'offer.bin'))).toEqual(Buffer.from([0, 3]));
});
it('preserves a deletion proposal when another writer edited the file', async () => {
  const { documents, a } = await fixture();
  await writeFile(join(documents, 'file'), 'base');
  await a.prepare();
  await rm(join(a.view, 'file'));
  await writeFile(join(documents, 'file'), 'editor');
  const result = await a.publish();
  expect(JSON.parse(await readFile(join(documents, result.conflicts[0]!), 'utf8')).deletion).toBe(
    true,
  );
  expect(await readFile(join(documents, 'file'), 'utf8')).toBe('editor');
});
it('deletes and renames without Git while retaining previous content', async () => {
  const { documents, a } = await fixture();
  await writeFile(join(documents, 'old'), 'base');
  await a.prepare();
  await rm(join(a.view, 'old'));
  await writeFile(join(a.view, 'new'), 'base');
  await a.publish();
  expect(await readFile(join(documents, 'new'), 'utf8')).toBe('base');
  await expect(readFile(join(documents, 'old'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await sessionFileHistory(documents, 'old')).versions).toHaveLength(1);
});
it('reconciles publication completed before a journal was cleared', async () => {
  const { a } = await fixture();
  await a.prepare();
  await writeFile(join(a.view, 'new'), 'content');
  await a.publish();
  const state = JSON.parse(await readFile(join(a.stateRoot, 'state.json'), 'utf8'));
  await writeFile(
    join(a.stateRoot, 'intent.json'),
    JSON.stringify({ path: 'new', before: null, after: state.files.new }),
  );
  await a.prepare();
  expect((await a.publish()).changed).toEqual([]);
});
it('rejects agent symlinks without touching their targets', async () => {
  const { root, documents, a } = await fixture();
  await a.prepare();
  await writeFile(join(root, 'outside'), 'safe');
  await symlink(join(root, 'outside'), join(a.view, 'escape'));
  await expect(a.publish()).rejects.toThrow('symlinks');
  expect(await readFile(join(root, 'outside'), 'utf8')).toBe('safe');
  expect(await readdir(documents)).toEqual([]);
});
it('retains late writes through a descriptor detached by refresh', async () => {
  const { documents, a, b } = await fixture();
  await writeFile(join(documents, 'note.md'), 'base');
  await Promise.all([a.prepare(), b.prepare()]);
  const { open } = await import('node:fs/promises');
  const writer = await open(join(a.view, 'note.md'), 'r+');
  try {
    await writeFile(join(b.view, 'note.md'), 'canonical');
    await b.publish();
    await a.prepare();
    await writer.truncate(0);
    await writer.writeFile('late writer');
    expect(await readFile(join(a.view, 'note.md'), 'utf8')).toBe('canonical');
    const records = await readdir(join(a.view, '.verity-file-history'));
    const retained = await Promise.all(
      records.map((record) =>
        readFile(join(a.view, '.verity-file-history', record, 'original'), 'utf8'),
      ),
    );
    expect(retained).toContain('late writer');
  } finally {
    await writer.close();
  }
});
it('retains independently created files and file-directory collisions', async () => {
  const { documents, a, b } = await fixture();
  await Promise.all([a.prepare(), b.prepare()]);
  await writeFile(join(a.view, 'new.md'), 'first');
  await writeFile(join(b.view, 'new.md'), 'second');
  await mkdir(join(a.view, 'folder'));
  await writeFile(join(a.view, 'folder', 'nested.md'), 'nested');
  await writeFile(join(b.view, 'folder'), 'file');
  await a.publish();
  const result = await b.publish();
  expect(result.conflicts).toHaveLength(2);
  expect(await readFile(join(documents, 'new.md'), 'utf8')).toBe('first');
  expect(await readFile(join(documents, 'folder', 'nested.md'), 'utf8')).toBe('nested');
});
it('transfers outstanding edits idempotently without overwriting destination edits', async () => {
  const { documents, a, b } = await fixture();
  await writeFile(join(documents, 'note.md'), 'base');
  await Promise.all([a.prepare(), b.prepare()]);
  await writeFile(join(a.view, 'note.md'), 'draft');
  await a.transferPending(b, 'Transferred');
  await a.transferPending(b, 'Transferred');
  await writeFile(join(b.view, 'Transferred', 'note.md'), 'destination edit');
  await expect(a.transferPending(b, 'Transferred')).rejects.toThrow('already changed');
  expect(await readFile(join(b.view, 'Transferred', 'note.md'), 'utf8')).toBe('destination edit');
  expect(await readFile(join(a.view, 'note.md'), 'utf8')).toBe('draft');
});

it.each(['file-to-directory', 'directory-to-file'] as const)(
  'retains both trees and permits repeated preparation after a %s replacement',
  async (transition) => {
    const { documents, a } = await fixture();
    const directoryFirst = transition === 'directory-to-file';
    if (directoryFirst) await mkdir(join(documents, 'entry'));
    const original = directoryFirst ? 'entry/note.md' : 'entry';
    await writeFile(join(documents, original), 'original');
    await a.prepare();
    await rm(join(documents, 'entry'), { recursive: true });
    if (!directoryFirst) await mkdir(join(documents, 'entry'));
    const replacement = directoryFirst ? 'entry' : 'entry/note.md';
    await writeFile(join(documents, replacement), 'replacement');
    await a.prepare();
    await a.prepare();
    expect(await readFile(join(a.view, original), 'utf8')).toBe('original');
    expect(await readFile(join(documents, replacement), 'utf8')).toBe('replacement');
    await writeFile(join(a.view, original), 'local edit');
    expect((await a.publish()).conflicts).toHaveLength(1);
  },
);
it('bounds a snapshot read even when the file grows after stat', async () => {
  const { documents, a } = await fixture();
  const path = join(documents, 'growing.md');
  await writeFile(path, 'base');
  const handle = await open(path, 'r');
  const prototype = Object.getPrototypeOf(handle) as typeof handle;
  await handle.close();
  // The spy forwards the actual FileHandle receiver with apply below.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalRead = prototype.read;
  let grew = false;
  const reads: number[] = [];
  const spy = vi.spyOn(prototype, 'read').mockImplementation(async function (
    this: typeof handle,
    ...args: Parameters<typeof handle.read>
  ) {
    if (!grew) {
      grew = true;
      await appendFile(path, Buffer.alloc(1024 * 1024));
    }
    if (!Buffer.isBuffer(args[0])) throw new Error('Expected a bounded buffer read');
    reads.push(args[0].length);
    return originalRead.apply(this, args);
  });
  try {
    await expect(a.prepare()).rejects.toThrow('still being written');
    expect(reads).toEqual([5]);
  } finally {
    spy.mockRestore();
  }
});

it.each(['path', 'ancestor'] as const)(
  'recovers a pending publication when its canonical %s changes type',
  async (collision) => {
    const { documents, a } = await fixture();
    const path = collision === 'path' ? 'entry' : 'entry/note.md';
    if (collision === 'ancestor') await mkdir(join(documents, 'entry'));
    await writeFile(join(documents, path), 'base');
    await a.prepare();
    await writeFile(join(a.view, path), 'pending edit');
    const state = JSON.parse(await readFile(join(a.stateRoot, 'state.json'), 'utf8'));
    await writeFile(
      join(a.stateRoot, 'intent.json'),
      JSON.stringify({
        path,
        before: state.files[path],
        after: 'interrupted-publication',
      }),
    );
    await rm(join(documents, 'entry'), { recursive: true });
    if (collision === 'path') await mkdir(join(documents, 'entry'));
    const competingPath = collision === 'path' ? 'entry/competing.md' : 'entry';
    await writeFile(join(documents, competingPath), 'other writer');
    await a.prepare();
    const publication = await a.publish();
    expect(publication.conflicts).toHaveLength(1);
    expect(await readFile(join(a.view, path), 'utf8')).toBe('pending edit');
    expect(await readFile(join(documents, competingPath), 'utf8')).toBe('other writer');
    await expect(readFile(join(a.stateRoot, 'intent.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  },
);

it('retains an oversized local edit without deleting its base or blocking other files', async () => {
  const { documents, a } = await fixture();
  await writeFile(join(documents, 'large.bin'), 'base');
  await a.prepare();
  await truncate(join(a.view, 'large.bin'), 65 * 1024 * 1024);
  await writeFile(join(a.view, 'note.md'), 'publish me');
  await a.prepare();
  const result = await a.publish();
  expect(result.changed).toEqual(['note.md']);
  expect(await readFile(join(documents, 'large.bin'), 'utf8')).toBe('base');
  expect((await stat(join(a.view, 'large.bin'))).size).toBe(65 * 1024 * 1024);
  expect(await a.hasPendingChanges()).toBe(true);
});
it('skips oversized canonical files during refresh, recovery and publication', async () => {
  const { documents, a, b } = await fixture();
  await writeFile(join(documents, 'large.bin'), 'base');
  await a.prepare();
  await writeFile(join(a.view, 'large.bin'), 'local edit');
  const state = JSON.parse(await readFile(join(a.stateRoot, 'state.json'), 'utf8'));
  await writeFile(
    join(a.stateRoot, 'intent.json'),
    JSON.stringify({ path: 'large.bin', before: state.files['large.bin'], after: 'interrupted' }),
  );
  await truncate(join(documents, 'large.bin'), 65 * 1024 * 1024);
  await writeFile(join(documents, 'note.md'), 'canonical');
  await Promise.all([a.prepare(), b.prepare()]);
  expect(await readFile(join(b.view, 'note.md'), 'utf8')).toBe('canonical');
  await writeFile(join(a.view, 'note.md'), 'updated');
  expect((await a.publish()).changed).toEqual(['note.md']);
  expect((await stat(join(documents, 'large.bin'))).size).toBe(65 * 1024 * 1024);
  expect(await readFile(join(a.view, 'large.bin'), 'utf8')).toBe('local edit');
});
