import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasCodeContent, legacySessionCodePath } from './project-code.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('reveals Code after a user file appears while ignoring metadata and generated dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-content-'));
  roots.push(root);
  await mkdir(join(root, '.git'));
  await writeFile(join(root, '.git', 'HEAD'), 'metadata');
  await writeFile(join(root, 'AGENTS.md'), 'instructions');
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules', 'package.js'), 'dependency');
  await mkdir(join(root, 'empty'));
  expect(await hasCodeContent(root)).toBe(false);
  await writeFile(join(root, 'empty', 'index.html'), '<html>');
  expect(await hasCodeContent(root)).toBe(true);
  await rm(join(root, 'empty', 'index.html'));
  expect(await hasCodeContent(root)).toBe(false);
});
it('counts user symlinks without following their targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-content-'));
  roots.push(root);
  await symlink('/missing-path', join(root, 'asset'));
  expect(await hasCodeContent(root)).toBe(true);
});
it('maps retained document sessions to a separate code worktree', () => {
  expect(legacySessionCodePath('/data/project/.verity-document-sessions/old', 'session-1')).toBe(
    '/data/project/.verity-sessions/code-session-1',
  );
  expect(
    legacySessionCodePath('/data/project/.verity-sessions/current', 'session-1'),
  ).toBeUndefined();
  expect(
    legacySessionCodePath('/data/project/.verity-document-sessions/old', '../bad'),
  ).toBeUndefined();
});
