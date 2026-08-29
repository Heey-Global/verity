import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeReferenceDocFile } from './reference-docs.js';

describe('writeReferenceDocFile', () => {
  let root: string;
  let referenceDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'verity-refdocs-'));
    referenceDir = join(root, 'docs', 'reference');
    await mkdir(referenceDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes the bytes to the target file', async () => {
    await writeReferenceDocFile(referenceDir, 'spec-abcd1234.md', new Uint8Array([1, 2, 3]));
    const written = await readFile(join(referenceDir, 'spec-abcd1234.md'));
    expect(Array.from(written)).toEqual([1, 2, 3]);
    // No temp files left behind.
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(referenceDir)).filter((n) => n.endsWith('.tmp'))).toHaveLength(0);
  });

  it('overwrites an existing regular file (re-import)', async () => {
    const target = join(referenceDir, 'spec-abcd1234.md');
    await writeFile(target, 'old');
    await writeReferenceDocFile(referenceDir, 'spec-abcd1234.md', Buffer.from('new'));
    expect(await readFile(target, 'utf8')).toBe('new');
  });

  it('replaces a pre-planted symlink instead of following it (no out-of-tree overwrite)', async () => {
    // An attacker-planted symlink at the deterministic target name, pointing at a
    // file OUTSIDE the worktree.
    const outside = join(root, 'outside-secret.txt');
    await writeFile(outside, 'DO NOT TOUCH');
    const target = join(referenceDir, 'spec-abcd1234.md');
    await symlink(outside, target);

    await writeReferenceDocFile(referenceDir, 'spec-abcd1234.md', Buffer.from('imported'));

    // The out-of-tree referent is untouched…
    expect(await readFile(outside, 'utf8')).toBe('DO NOT TOUCH');
    // …and the target is now a regular file (the symlink was replaced) holding our bytes.
    expect((await lstat(target)).isSymbolicLink()).toBe(false);
    expect((await lstat(target)).isFile()).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('imported');
  });
});
