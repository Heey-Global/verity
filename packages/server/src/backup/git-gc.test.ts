import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { captureFrozenGit, freezeGitDirectory } from './git.js';
const race = vi.hoisted(() => ({ run: undefined as (() => Promise<void>) | undefined }));
vi.mock('./filesystem.js', async (originalImport) => {
  const original = await originalImport<typeof import('./filesystem.js')>();
  return {
    ...original,
    captureTree: async function* (...args: Parameters<typeof original.captureTree>) {
      for await (const entry of original.captureTree(...args)) {
        // Synchronize a real repack after a loose object's stat and before its contents are read.
        if (race.run && /^git\/objects\/[a-f0-9]{2}\/[a-f0-9]+$/.test(entry.path)) {
          const run = race.run;
          race.run = undefined;
          await run();
        }
        yield entry;
      }
    },
  };
});
const exec = promisify(execFile);
it('re-freezes after an actual concurrent gc removes a listed loose object and refuses borrowed-only history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-gc-'));
  const project = join(root, 'project');
  const staging = join(root, 'staging');
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const git = (...args: string[]) => exec('/usr/bin/git', ['-C', project, ...args], { env });
  try {
    await mkdir(project);
    await mkdir(staging);
    await git('init');
    await writeFile(join(project, 'file'), 'recoverable');
    await git('add', '.');
    await git('commit', '-m', 'initial');
    let collections = 0,
      attempts = 0;
    race.run = async () => {
      await git('gc', '--prune=now');
      collections++;
    };
    const frozen = await captureFrozenGit(project, '.git', staging, async (action) => {
      attempts++;
      return action();
    });
    expect(collections).toBe(1);
    expect(attempts).toBe(2);
    expect(frozen.status).toBe('validated');
    expect(
      (await exec('/usr/bin/git', ['--git-dir', frozen.git, 'show', 'HEAD:file'], { env })).stdout,
    ).toBe('recoverable');
    const borrowed = join(root, 'borrowed');
    await exec('/usr/bin/git', ['clone', '--shared', project, borrowed], { env });
    await access(join(borrowed, '.git/objects/info/alternates'));
    const missing = await freezeGitDirectory(borrowed, '.git', staging);
    expect(missing.findings).toContain('alternates-dropped');
    expect(missing.status).toBe('not-validated');
    await expect(access(join(missing.git, 'objects/info/alternates'))).rejects.toThrow();
    expect(await readFile(join(missing.userFiles, 'objects/info/alternates'), 'utf8')).toContain(
      project,
    );
  } finally {
    race.run = undefined;
    await rm(root, { recursive: true, force: true });
  }
});
