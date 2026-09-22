import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import {
  ensureProjectKnowledge,
  ensureSharedKnowledge,
  projectKnowledgeDir,
  sharedKnowledgeDir,
} from './knowledge-folder.js';
import { KnowledgePublishConflictError, publishSharedInsight } from './knowledge-publish.js';

let dataRoot: string;
beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'verity-knowledge-publish-'));
});
afterEach(() => rmSync(dataRoot, { recursive: true, force: true }));

it('publishes and conflict-checks project insights in Shared', async () => {
  await ensureProjectKnowledge(dataRoot, 'project');
  await ensureSharedKnowledge(dataRoot);
  const projectFile = join(projectKnowledgeDir(dataRoot, 'project'), 'insights/profile.md');
  writeFileSync(projectFile, '# Project profile\n');

  const created = await publishSharedInsight(dataRoot, 'project', { path: 'profile.md' });
  expect(created).toMatchObject({ path: 'insights/profile.md', replaced: false });
  const sharedFile = join(sharedKnowledgeDir(dataRoot), 'insights/profile.md');
  expect(readFileSync(sharedFile, 'utf8')).toBe('# Project profile\n');

  writeFileSync(projectFile, '# Revised profile\n');
  await expect(publishSharedInsight(dataRoot, 'project', { path: 'profile.md' })).rejects.toEqual(
    expect.any(KnowledgePublishConflictError),
  );
  const expectedDigest = createHash('sha256').update('# Project profile\n').digest('hex');
  const replaced = await publishSharedInsight(dataRoot, 'project', {
    path: 'profile.md',
    expectedDigest,
  });
  expect(replaced.replaced).toBe(true);
  expect(readFileSync(sharedFile, 'utf8')).toBe('# Revised profile\n');
});

it('only publishes Markdown files from the project insights folder', async () => {
  await ensureProjectKnowledge(dataRoot, 'project');
  writeFileSync(
    join(projectKnowledgeDir(dataRoot, 'project'), 'sources/documents/source.md'),
    'source',
  );
  await expect(
    publishSharedInsight(dataRoot, 'project', { path: '../sources/documents/source.md' }),
  ).rejects.toThrow(/invalid path/u);
  await expect(publishSharedInsight(dataRoot, 'project', { path: 'profile.txt' })).rejects.toThrow(
    /Markdown/u,
  );
});

it('does not follow a symlinked insights parent outside the project', async () => {
  await ensureProjectKnowledge(dataRoot, 'project');
  const outside = join(dataRoot, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.md'), 'secret');
  symlinkSync(outside, join(projectKnowledgeDir(dataRoot, 'project'), 'insights/nested'));

  await expect(
    publishSharedInsight(dataRoot, 'project', { path: 'nested/secret.md' }),
  ).rejects.toThrow();
  expect(() =>
    readFileSync(join(sharedKnowledgeDir(dataRoot), 'insights/nested/secret.md')),
  ).toThrow();
});

it('allows only one concurrent first publication to a shared destination', async () => {
  await ensureProjectKnowledge(dataRoot, 'project');
  const insights = join(projectKnowledgeDir(dataRoot, 'project'), 'insights');
  writeFileSync(join(insights, 'first.md'), 'first');
  writeFileSync(join(insights, 'second.md'), 'second');

  const results = await Promise.allSettled([
    publishSharedInsight(dataRoot, 'project', { path: 'first.md', sharedPath: 'profile.md' }),
    publishSharedInsight(dataRoot, 'project', { path: 'second.md', sharedPath: 'profile.md' }),
  ]);

  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect(['first', 'second']).toContain(
    readFileSync(join(sharedKnowledgeDir(dataRoot), 'insights/profile.md'), 'utf8'),
  );
});
