import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readWikiPage } from './wiki-page-reader.js';

let dataRoot: string;
beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), 'wiki-reader-'));
  await mkdir(join(dataRoot, 'knowledge/p/insights'), { recursive: true });
});
afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});
const read = (path: string, extra = {}) =>
  readWikiPage(dataRoot, 'p', { operation: 'read_wiki_page', path, ...extra });

it('returns text in bounded pages and lists relevant directories', async () => {
  const text = 'a'.repeat(40_000) + 'second page';
  await writeFile(join(dataRoot, 'knowledge/p/insights/index.md'), text);
  const first = await read('insights/index.md');
  expect(first).toMatchObject({
    text: 'a'.repeat(40_000),
    nextOffset: 40_000,
    textLength: text.length,
  });
  const last = await read('insights/index.md', { offset: first.nextOffset });
  expect(last).toMatchObject({ text: 'second page' });
  expect(last).not.toHaveProperty('nextOffset');
  expect(await read('insights', { list: true })).toMatchObject({
    entries: [{ name: 'index.md', kind: 'file' }],
    truncated: false,
  });
});

it('reads shared and extracted source text without exposing another project', async () => {
  await mkdir(join(dataRoot, 'knowledge/shared/.text/sources'), { recursive: true });
  await writeFile(join(dataRoot, 'knowledge/shared/.text/sources/source.pdf.md'), 'shared source');
  expect(await read('shared/.text/sources/source.pdf.md')).toMatchObject({ text: 'shared source' });
  for (const path of [
    '../other/insights/a.md',
    'shared/../p/insights/index.md',
    '/insights/index.md',
    'overview.md',
    'insights/.private',
    'sources/../../other',
    'insights/a\\b',
  ])
    await expect(read(path)).rejects.toThrow();
});

// A source can contain links created outside the agent. Neither the final file nor
// an intermediate directory may redirect this tool into another project's data.
it('refuses symlink files and directories and omits links from listings', async () => {
  await mkdir(join(dataRoot, 'knowledge/other/insights'), { recursive: true });
  await writeFile(join(dataRoot, 'knowledge/other/insights/private.md'), 'private');
  await symlink(
    join(dataRoot, 'knowledge/other/insights/private.md'),
    join(dataRoot, 'knowledge/p/insights/link.md'),
  );
  await symlink(
    join(dataRoot, 'knowledge/other/insights'),
    join(dataRoot, 'knowledge/p/insights/linked'),
  );
  await expect(read('insights/link.md')).rejects.toThrow();
  await expect(read('insights/linked/private.md')).rejects.toThrow();
  await expect(read('insights/linked', { list: true })).rejects.toThrow();
  expect(await read('insights', { list: true })).toMatchObject({ entries: [] });
});

it('refuses binary files and oversized text', async () => {
  await writeFile(join(dataRoot, 'knowledge/p/insights/binary.md'), Buffer.from([0, 255]));
  await expect(read('insights/binary.md')).rejects.toThrow('not text');
  await writeFile(join(dataRoot, 'knowledge/p/insights/large.md'), 'x'.repeat(4_000_001));
  await expect(read('insights/large.md')).rejects.toThrow('limit');
});
