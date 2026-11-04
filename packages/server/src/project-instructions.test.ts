import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectInstructions, replaceProjectInstructions } from './project-instructions.js';
import { projectKnowledgeDir } from './knowledge-folder.js';
import { isManagedKnowledgePath } from './session-files.js';
let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
describe('project Instructions', () => {
  it('preserves explicit empty content and rejects concurrent stale edits', async () => {
    root = await mkdtemp(join(tmpdir(), 'instructions-'));
    const initial = await readProjectInstructions(root, 'p1');
    const saved = await replaceProjectInstructions(root, 'p1', initial.revision, 'Project rules');
    await expect(replaceProjectInstructions(root, 'p1', initial.revision, 'stale')).rejects.toThrow(
      'changed',
    );
    expect((await readProjectInstructions(root, 'p2')).instructions).toBe('');
    await replaceProjectInstructions(root, 'p1', saved.revision, '');
    expect((await readProjectInstructions(root, 'p1')).instructions).toBe('');
    expect(isManagedKnowledgePath('knowledge', 'AGENTS.md')).toBe(true);
    expect(isManagedKnowledgePath('documents', 'AGENTS.md')).toBe(false);
  });
  it('refuses a symlink instead of importing instructions from another file', async () => {
    root = await mkdtemp(join(tmpdir(), 'instructions-'));
    await readProjectInstructions(root, 'p1');
    await symlink('/etc/passwd', join(projectKnowledgeDir(root, 'p1'), 'AGENTS.md'));
    await expect(readProjectInstructions(root, 'p1')).rejects.toThrow();
  });
});
