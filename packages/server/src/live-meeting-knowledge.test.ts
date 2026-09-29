import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { meetingKnowledgeExcerpts } from './live-meeting-knowledge.js';

it('retrieves only relevant files from the session project and ignores symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'meeting-knowledge-'));
  try {
    const first = join(root, 'knowledge', 'first', 'insights');
    const other = join(root, 'knowledge', 'other', 'insights');
    await mkdir(first, { recursive: true });
    await mkdir(other, { recursive: true });
    const extracted = join(root, 'knowledge', 'first', '.text', 'sources', 'documents');
    await mkdir(extracted, { recursive: true });
    await writeFile(join(first, 'plan.md'), 'The delivery date is Tuesday.');
    await writeFile(
      join(first, 'long.md'),
      `Delivery commitment is Thursday. ${'Unrelated details. '.repeat(100)}`,
    );
    await writeFile(join(extracted, 'contract.pdf.md'), 'The contract delivery date is Wednesday.');
    await writeFile(join(other, 'private.md'), 'The delivery date is Friday.');
    await symlink(join(other, 'private.md'), join(first, 'linked.md'));
    await symlink(other, join(root, 'knowledge', 'first', 'sources'));
    await symlink(join(root, 'knowledge', 'other'), join(root, 'knowledge', 'linked'));
    const excerpts = await meetingKnowledgeExcerpts(root, 'first', 'Is the delivery date Friday?');
    expect(excerpts).toEqual(
      expect.arrayContaining([
        { path: 'insights/plan.md', text: 'The delivery date is Tuesday.' },
        {
          path: 'sources/documents/contract.pdf',
          text: 'The contract delivery date is Wednesday.',
        },
      ]),
    );
    expect(excerpts).toHaveLength(3);
    expect(excerpts).toContainEqual(expect.objectContaining({ path: 'insights/long.md' }));
    expect(await meetingKnowledgeExcerpts(root, 'linked', 'delivery date Friday')).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
