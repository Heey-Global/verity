import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const wt = resolve('features/verity-sandbox-toolkit/bin/wt');

async function fixture(branch: string, escapedPath = false) {
  const root = await mkdtemp(join(tmpdir(), 'verity-wt-'));
  const bin = join(root, 'bin');
  const workspace = join(root, 'workspace');
  const log = join(root, 'calls.log');
  await mkdir(bin);
  await mkdir(join(workspace, '.worktrees'), { recursive: true });
  await writeFile(
    join(bin, 'git'),
    `#!/bin/sh
printf 'git %s\n' "$*" >> "$MOCK_LOG"
if [ "$*" = "-C $WORKSPACE worktree list --porcelain -z" ]; then
  printf 'worktree %s\\0HEAD abcdef\\0branch refs/heads/%s\\0\\0' "$REGISTERED_PATH" "$REGISTERED_BRANCH"
  exit 0
fi
if [ "$*" = "-C $REGISTERED_PATH status --porcelain --untracked-files=all" ]; then
  printf '%s' "\${MOCK_DIRTY:-}"
fi
exit 0
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, 'tmux'),
    `#!/bin/sh
printf 'tmux %s\n' "$*" >> "$MOCK_LOG"
if [ "$1" = list-windows ]; then printf '3\\t%s\n' "$REGISTERED_PATH"; fi
`,
    { mode: 0o755 },
  );
  const registeredPath = escapedPath
    ? `${workspace}/.worktrees/../outside`
    : join(workspace, '.worktrees', 'registered');
  return {
    root,
    log,
    registeredPath,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      WORKSPACE: workspace,
      MOCK_LOG: log,
      REGISTERED_BRANCH: branch,
      REGISTERED_PATH: registeredPath,
    },
  };
}

describe('wt close', () => {
  it('does not remove a colliding sanitized path for a different branch', async () => {
    const f = await fixture('feature/a-b');
    const result = await execFileAsync(wt, ['close', 'feature-a/b'], { env: f.env });
    expect(result.stdout).toContain("No worktree registered for branch 'feature-a/b'.");
    const calls = await readFile(f.log, 'utf8');
    expect(calls).not.toContain('worktree remove');
    expect(calls).not.toContain('kill-window');
  });

  it('removes only the exact branch path resolved by git metadata', async () => {
    const f = await fixture('feature/a-b');
    await execFileAsync(wt, ['close', 'feature/a-b'], { env: f.env });
    const calls = await readFile(f.log, 'utf8');
    expect(calls).toContain(`worktree remove ${f.registeredPath}`);
    expect(calls).toContain('kill-window -t verity:3');
  });

  it('refuses a dirty worktree unless --force is explicit', async () => {
    const f = await fixture('feature/dirty');
    const env = { ...f.env, MOCK_DIRTY: ' M changed.ts' };
    await expect(execFileAsync(wt, ['close', 'feature/dirty'], { env })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Refusing to remove dirty worktree'),
    });
    expect(await readFile(f.log, 'utf8')).not.toContain('worktree remove');
    await execFileAsync(wt, ['close', '--force', 'feature/dirty'], { env });
    expect(await readFile(f.log, 'utf8')).toContain(`worktree remove ${f.registeredPath} --force`);
  });

  it('rejects git metadata whose apparent managed prefix resolves outside it', async () => {
    const f = await fixture('feature/a-b', true);
    await expect(execFileAsync(wt, ['close', 'feature/a-b'], { env: f.env })).rejects.toMatchObject(
      {
        code: 1,
        stderr: expect.stringContaining('Refusing to remove worktree outside'),
      },
    );
    expect(await readFile(f.log, 'utf8')).not.toContain('worktree remove');
  });
});

describe('wt status', () => {
  it('preserves worktree paths containing spaces', async () => {
    const f = await fixture('feature/spaces');
    const spaced = join(f.env.WORKSPACE, '.worktrees', 'path with spaces');
    await mkdir(spaced, { recursive: true });
    const env = { ...f.env, REGISTERED_PATH: spaced };
    const result = await execFileAsync(wt, ['status'], { env });
    expect(result.stdout).toContain(`=== ${spaced} ===`);
    expect(await readFile(f.log, 'utf8')).toContain(`git -C ${spaced} status --short --branch`);
  });
});
