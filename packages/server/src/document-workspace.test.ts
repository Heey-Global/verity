import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises';
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
