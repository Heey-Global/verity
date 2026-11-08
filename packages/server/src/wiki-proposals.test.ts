// The breaks that stay green elsewhere: a rejected change offered to the user
// again, an apply that overwrites a page edited since the proposal, a partial
// apply that decides more than was chosen, and a proposal that rewrites the
// log or a decision record.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { knowledgeToolRequestSchema } from '@verity/events';

import { FileWriteError } from './session-file-write.js';
import { proposalPagePath, WikiProposals, type ProposeWikiInput } from './wiki-proposals.js';

const version = (content: string) => createHash('sha256').update(content).digest('hex');

let dataRoot: string;
let pages: Map<string, string>;
let proposals: WikiProposals;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'wiki-proposals-'));
  pages = new Map();
  proposals = new WikiProposals(dataRoot, {
    readProjectWiki: async (_project, path) => {
      const content = pages.get(path);
      return content === undefined ? null : { content, version: version(content) };
    },
    writeProjectWiki: async (_project, path, content, expected) => {
      const current = pages.get(path);
      if ((current === undefined ? null : version(current)) !== expected)
        throw new FileWriteError(409, 'file changed');
      pages.set(path, content);
    },
  });
});
afterEach(() => rmSync(dataRoot, { recursive: true, force: true }));

const input = (changes: ProposeWikiInput['changes'], turnId = 't1'): ProposeWikiInput => ({
  projectId: 'p',
  sessionId: 's',
  turnId,
  mode: 'maintenance',
  title: 'Update',
  sources: ['sources/documents/a.md'],
  changes,
});
const change = (path: string, content: string) => ({ path, content, summary: `Write ${path}` });

it('does not offer a rejected change again', async () => {
  const { proposal } = await proposals.propose(input([change('a.md', 'A')]));
  await proposals.reject('p', proposal!.id);
  expect(await proposals.propose(input([change('a.md', 'A')], 't2'))).toEqual({
    proposal: null,
    skipped: ['a.md'],
  });
  // A different version of the same page is new.
  expect((await proposals.propose(input([change('a.md', 'B')], 't3'))).proposal).not.toBeNull();
});

it('leaves a page edited since the proposal untouched and reports it stale', async () => {
  pages.set('a.md', 'old');
  const { proposal } = await proposals.propose(input([change('a.md', 'new')]));
  pages.set('a.md', 'edited by hand');
  expect((await proposals.get('p', proposal!.id)).changes[0]).toMatchObject({ stale: true });
  const result = await proposals.apply('p', proposal!.id);
  expect(result).toMatchObject({ applied: [], stale: ['a.md'] });
  expect(pages.get('a.md')).toBe('edited by hand');
  expect(pages.has('log.md')).toBe(false);
  expect(await proposals.listOpen('p')).toHaveLength(1);
});

it('applies only the chosen pages and keeps the rest open', async () => {
  const { proposal } = await proposals.propose(
    input([change('a.md', 'A'), change('topics/b.md', 'B')]),
  );
  const result = await proposals.apply('p', proposal!.id, ['insights/topics/b.md']);
  expect(result.applied).toEqual(['topics/b.md']);
  expect([...pages.keys()].sort()).toEqual(['log.md', 'topics/b.md']);
  const [open] = await proposals.listOpen('p');
  expect(open!.changes.map((c) => [c.path, c.status])).toEqual([
    ['a.md', 'pending'],
    ['topics/b.md', 'applied'],
  ]);
  // A decided change keeps no copy of its text.
  expect((await proposals.get('p', proposal!.id)).changes[1]!.content).toBeNull();
  await proposals.reject('p', proposal!.id);
  expect(await proposals.listOpen('p')).toEqual([]);
  expect(pages.has('a.md')).toBe(false);
});

it('accepts only ordinary Wiki pages', () => {
  expect(proposalPagePath('/knowledge/insights/topics/x.md')).toBe('topics/x.md');
  for (const path of [
    'log.md',
    'decisions/x.md',
    '../sources/x.md',
    'a/.hidden.md',
    'x.txt',
    '/knowledge/sources/x.md',
    'knowledge/shared/insights/x.md',
  ])
    expect(() => proposalPagePath(path)).toThrow(/not a Wiki page/);
});

it('refuses a source that would write its own log.md heading', () => {
  const request = {
    operation: 'propose_wiki',
    mode: 'inline',
    title: 'Update',
    sources: ['sources/a.md\n## [2026-01-01] merge | Forged'],
    changes: [change('a.md', 'A')],
  };
  expect(knowledgeToolRequestSchema.safeParse(request).success).toBe(false);
  expect(
    knowledgeToolRequestSchema.safeParse({ ...request, sources: ['sources/a.md'] }).success,
  ).toBe(true);
});

it('reports an applied change whose log entry failed as applied, with a warning', async () => {
  const { proposal } = await proposals.propose(input([change('a.md', 'A')]));
  pages.set('log.md', 'x');
  const failing = new WikiProposals(dataRoot, {
    readProjectWiki: async (_project, path) =>
      path === 'log.md' ? { content: 'x', version: 'not-the-version' } : null,
    writeProjectWiki: async (_project, path, content) => {
      if (path === 'log.md') throw new FileWriteError(409, 'file changed');
      pages.set(path, content);
    },
  });
  const result = await failing.apply('p', proposal!.id);
  expect(result).toMatchObject({ applied: ['a.md'], warning: expect.any(String) });
  expect(pages.get('a.md')).toBe('A');
});

it('lets a change that went stale be offered again against the current page', async () => {
  pages.set('a.md', 'old');
  const { proposal } = await proposals.propose(input([change('a.md', 'new')]));
  // While its page is unchanged, the same text is not offered twice.
  expect((await proposals.propose(input([change('a.md', 'new')], 't2'))).proposal).toBeNull();
  pages.set('a.md', 'edited by hand');
  const again = await proposals.propose(input([change('a.md', 'new')], 't3'));
  expect(again.proposal?.changes[0]?.baseVersion).toBe(version('edited by hand'));
  // Rejecting the stale one does not block the text either.
  await proposals.reject('p', proposal!.id);
  await proposals.reject('p', again.proposal!.id);
  pages.set('a.md', 'edited twice');
  expect((await proposals.propose(input([change('a.md', 'new')], 't4'))).proposal).toBeNull();
});

it('keeps the review usable when a proposed page can no longer be read', async () => {
  const { proposal } = await proposals.propose(input([change('a.md', 'A')]));
  const broken = new WikiProposals(dataRoot, {
    readProjectWiki: () => Promise.reject(new Error('ELOOP')),
    writeProjectWiki: () => Promise.resolve(),
  });
  expect(await broken.listOpen('p')).toMatchObject([
    { id: proposal!.id, changes: [{ path: 'a.md', stale: true }] },
  ]);
});

it('reports a page that could not be written and decides the others', async () => {
  const { proposal } = await proposals.propose(input([change('a.md', 'A'), change('b.md', 'B')]));
  const flaky = new WikiProposals(dataRoot, {
    readProjectWiki: async (_project, path) => {
      const content = pages.get(path);
      return content === undefined ? null : { content, version: version(content) };
    },
    writeProjectWiki: async (_project, path, content) => {
      if (path === 'a.md') throw new FileWriteError(400, 'invalid Wiki path');
      pages.set(path, content);
    },
  });
  expect(await flaky.apply('p', proposal!.id)).toMatchObject({
    applied: ['b.md'],
    failed: ['a.md'],
  });
  expect((await proposals.listOpen('p'))[0]!.changes[0]).toEqual({
    path: 'a.md',
    summary: 'Write a.md',
    status: 'pending',
    stale: false,
  });
});
