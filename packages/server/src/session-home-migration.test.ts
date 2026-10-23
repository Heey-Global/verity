import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { migrateSessionArtifact } from './session-home-migration.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'verity-native-migration-'));
  roots.push(root);
  await mkdir(join(root, 'legacy', 'subagents'), { recursive: true });
  await mkdir(join(root, 'new'), { recursive: true });
  return root;
}

it('preserves complete attributed subtrees and originals without overwriting newer state', async () => {
  const root = await fixture();
  const content = 'tool result\n'.repeat(20000);
  await writeFile(join(root, 'legacy', 'subagents', 'child.jsonl'), content);
  await migrateSessionArtifact(join(root, 'legacy'), join(root, 'new'), root);
  expect(await readFile(join(root, 'new', 'subagents', 'child.jsonl'), 'utf8')).toBe(content);
  expect(await readFile(join(root, 'legacy', 'subagents', 'child.jsonl'), 'utf8')).toBe(content);
  await writeFile(join(root, 'new', 'subagents', 'child.jsonl'), 'next turn');
  await migrateSessionArtifact(join(root, 'legacy'), join(root, 'new'), root);
  expect(await readFile(join(root, 'new', 'subagents', 'child.jsonl'), 'utf8')).toBe('next turn');
});

it('rejects symlink sources and destination ancestors and leaves unrelated data intact', async () => {
  const root = await fixture();
  const other = await fixture();
  await writeFile(join(other, 'keep'), 'other session');
  await symlink(join(other, 'keep'), join(root, 'legacy', 'link'));
  await expect(
    migrateSessionArtifact(join(root, 'legacy'), join(root, 'new'), root),
  ).rejects.toThrow('symbolic links');
  await symlink(other, join(root, 'redirect'));
  await expect(
    migrateSessionArtifact(join(root, 'legacy'), join(root, 'redirect', 'copy'), root),
  ).rejects.toThrow('symbolic links');
  expect(await readFile(join(other, 'keep'), 'utf8')).toBe('other session');
});
