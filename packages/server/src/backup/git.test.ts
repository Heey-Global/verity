import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, mkdir, writeFile, readFile, rm, symlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { captureFrozenGit, freezeGitDirectory, runBackupGit, sanitizedGitConfig } from './git.js';
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'verity-git-freeze-'));
  roots.push(root);
  const project = join(root, 'project');
  const staging = join(root, 'private');
  await mkdir(project);
  await mkdir(staging);
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
  await exec('git', ['init', project], { env });
  await writeFile(join(project, 'file'), 'complete local history');
  await exec('git', ['-C', project, 'add', '.'], { env });
  await exec('git', ['-C', project, 'commit', '-m', 'initial'], { env });
  return { root, project, staging, env };
}
describe('private Git backup freeze', () => {
  it('repairs a private staged repository that has no linked worktrees', async () => {
    const { project, staging } = await fixture();
    const frozen = await freezeGitDirectory(project, '.git', staging);
    expect(frozen.status).toBe('validated');
    const work = join(staging, 'restored');
    await mkdir(work);
    await cp(frozen.git, join(work, '.git'), { recursive: true });
    expect(await runBackupGit(join(work, '.git'), staging, 'repair', work)).toBe(true);
  });

  it('checks self-contained objects without executing original configuration, includes or hooks', async () => {
    const { root, project, staging } = await fixture();
    const marker = join(root, 'executed');
    const config = `[core]\nrepositoryformatversion = 0\nbare = false\nfsmonitor = touch ${marker}\nalternateRefsCommand = touch ${marker}\n[include]\npath = ${root}/outside-config\n[credential]\nhelper = !touch ${marker}\n`;
    await writeFile(join(project, '.git/config'), config);
    await writeFile(join(project, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch ${marker}\n`, {
      mode: 0o755,
    });
    const frozen = await freezeGitDirectory(project, '.git', staging);
    expect(frozen.status).toBe('validated');
    expect(await readFile(join(frozen.userFiles, 'config'), 'utf8')).toBe(config);
    expect(await readFile(join(frozen.git, 'config'), 'utf8')).not.toContain('touch');
    await expect(access(join(frozen.git, 'hooks/post-checkout'))).rejects.toThrow();
    await expect(access(marker)).rejects.toThrow();
    // No index or code host is needed to find the committed content in the frozen repository.
    const { stdout } = await exec('git', ['--git-dir', frozen.git, 'show', 'HEAD:file'], {
      env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    expect(stdout).toBe('complete local history');
  });
  it('omits links and refuses out-of-project pointers even when alternates are also present', async () => {
    const { project, staging } = await fixture();
    await symlink('/outside/secrets', join(project, '.git/leak'));
    await writeFile(join(project, '.git/commondir'), '/outside/repository\n');
    await writeFile(join(project, '.git/objects/info/alternates'), '/outside/objects\n');
    const frozen = await freezeGitDirectory(project, '.git', staging);
    expect(frozen.status).toBe('not-validated');
    expect(frozen.findings).toContain('symlink:leak');
    expect(frozen.findings).toContain('unsafe-pointer:commondir');
    await expect(access(join(frozen.git, 'leak'))).rejects.toThrow();
    await expect(access(join(frozen.git, 'objects/info/alternates'))).rejects.toThrow();
  });
  it('does not honor alternates and flags missing borrowed history without re-freezing', async () => {
    const { project, staging } = await fixture();
    await writeFile(join(project, '.git/objects/info/alternates'), '/outside/objects\n');
    let freezes = 0;
    const frozen = await captureFrozenGit(project, '.git', staging, async (action) => {
      freezes++;
      return action();
    });
    expect(freezes).toBe(1);
    expect(frozen.status).toBe('alternates-dropped');
  });
  it('bounds connectivity retries and refuses unsupported repository extensions', async () => {
    const { project, staging } = await fixture();
    await rm(join(project, '.git/objects'), { recursive: true });
    await mkdir(join(project, '.git/objects'));
    let freezes = 0;
    const frozen = await captureFrozenGit(project, '.git', staging, async (action) => {
      freezes++;
      return action();
    });
    expect(freezes).toBe(3);
    expect(frozen.status).toBe('unstable');
    expect(sanitizedGitConfig('[extensions]\nrefStorage = reftable\n')).toBeUndefined();
    expect(sanitizedGitConfig('[core]\nbare = true\\\n[include]\npath=/outside')).toBeUndefined();
  });
  it('checks a linked worktree registration using private placeholders', async () => {
    const { project, staging, env } = await fixture();
    await exec(
      'git',
      ['-C', project, 'worktree', 'add', '-b', 'session', join(project, 'session')],
      { env },
    );
    const frozen = await freezeGitDirectory(project, '.git', staging);
    expect(frozen.status).toBe('validated');
    expect(frozen.pointers.map((entry) => entry.path)).toContain('worktrees/session/gitdir');
    expect(await readFile(join(frozen.git, 'worktrees/session/gitdir'), 'utf8')).not.toContain(
      project,
    );
  });
});
