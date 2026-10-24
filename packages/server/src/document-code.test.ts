import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectDocumentCode } from './document-code.js';
import type { GitRunner } from './provisioner.js';
const exec = promisify(execFile);
const git: GitRunner = (args) => exec('git', [...args]);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'document-code-'));
  roots.push(root);
  const remote = join(root, 'remote');
  const workspace = join(root, 'workspace');
  await git(['init', remote]);
  await writeFile(join(remote, 'code.ts'), 'remote code');
  await git(['-C', remote, 'add', '.']);
  await git([
    '-C',
    remote,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'Initial code',
  ]);
  await mkdir(join(workspace, '.verity-document-sessions'), { recursive: true });
  await writeFile(join(workspace, '.verity-document-sessions', 'draft'), 'private document');
  return { remote, workspace };
}
it('fetches code without including documents and preserves edits on connection retry', async () => {
  const { remote, workspace } = await fixture();
  const input = { workspace, url: remote, authorization: '', git };
  expect(await connectDocumentCode(input)).toEqual({ empty: false });
  expect(await readFile(join(workspace, 'code.ts'), 'utf8')).toBe('remote code');
  expect((await git(['-C', workspace, 'ls-files'])).stdout.trim()).toBe('code.ts');
  await writeFile(join(workspace, 'code.ts'), 'edited code');
  await connectDocumentCode(input);
  expect(await readFile(join(workspace, 'code.ts'), 'utf8')).toBe('edited code');
});
it('resumes checkout after interruption without resetting existing edits', async () => {
  const { remote, workspace } = await fixture();
  let interrupted = false;
  const failingGit: GitRunner = async (args) => {
    if (args.includes('checkout-index') && !interrupted) {
      interrupted = true;
      throw new Error('interrupted');
    }
    return git(args);
  };
  await expect(
    connectDocumentCode({ workspace, url: remote, authorization: '', git: failingGit }),
  ).rejects.toThrow('interrupted');
  await connectDocumentCode({ workspace, url: remote, authorization: '', git });
  expect(await readFile(join(workspace, 'code.ts'), 'utf8')).toBe('remote code');
});
it('refuses a remote file that collides with a local document', async () => {
  const { remote, workspace } = await fixture();
  await writeFile(join(workspace, 'code.ts'), 'document');
  await expect(
    connectDocumentCode({ workspace, url: remote, authorization: '', git }),
  ).rejects.toThrow('replace an existing');
  expect(await readFile(join(workspace, 'code.ts'), 'utf8')).toBe('document');
});
