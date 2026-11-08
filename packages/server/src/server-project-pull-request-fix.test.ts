import type { Backend } from '@verity/session';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { bus, conductor, ctx, dispatchTurn } from './server-fixture.test-helper.js';
import type { ProjectPullRequestBackend } from './project-pull-requests.js';
import { buildServer } from './server.js';

const failing = {
  number: 7,
  title: 'Bump left-pad',
  url: 'https://example.test/pr/7',
  phase: 'open' as const,
  headSha: 'abc1234',
  baseRef: 'main',
  pipeline: 'failure' as const,
  mergeable: true,
  mergeState: 'clean' as const,
  checks: { completed: 1, total: 1, failed: 1, successful: 0, pending: 0 },
};

let cloneRoot: string | undefined;
afterEach(() => {
  if (cloneRoot) rmSync(cloneRoot, { recursive: true, force: true });
  cloneRoot = undefined;
});

/** The project's clone: a fix session is a worktree of it. */
function makeClone(): string {
  cloneRoot = mkdtempSync(join(tmpdir(), 'pr-fix-'));
  const clone = join(cloneRoot, 'team-site');
  mkdirSync(clone);
  const git = (...args: string[]) => execFileSync('git', ['-C', clone, ...args]);
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return `${cloneRoot}/`;
}

async function fixServer() {
  await ctx.store.upsertProject({
    id: 'p-fix',
    owner: 'team',
    repo: 'site',
    containerName: 'dev-team-site',
    state: 'active',
  });
  const backend: ProjectPullRequestBackend = {
    list: vi.fn().mockResolvedValue({ webUrl: 'https://github.com/team/site', pulls: [] }),
    status: vi.fn().mockResolvedValue(failing),
    merge: vi.fn().mockResolvedValue(true),
  };
  return buildServer({
    eventStore: ctx.store,
    bus,
    conductor,
    projectPullRequests: backend,
    provisioner: {
      provision: vi.fn(async (id: string) => (await ctx.store.getProject(id))!),
    },
    projectCloneRoot: makeClone(),
    projectBackend: (_project: unknown, selected: Backend) => selected,
  });
}

const tapFix = (app: Awaited<ReturnType<typeof fixServer>>) =>
  app.inject({
    method: 'POST',
    url: '/projects/p-fix/pull-requests/default:p-fix/7/fix',
    payload: { branch: 'renovate/left-pad' },
  });

// The durable origin outlives the request. If it kept naming a session that
// never received its prompt, every later tap would answer "already fixing" and
// the pull request could never be fixed from the app again.
it('lets the next Fix tap start over when the first session never got its prompt', async () => {
  const app = await fixServer();
  try {
    dispatchTurn.mockRejectedValueOnce(new Error('runner unavailable'));
    const failed = await tapFix(app);
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ error: 'The fix session could not be started. Try again.' });
    const orphan = await ctx.store.repairs.sessionOrigin('p-fix', 'pr:7');
    // The unprompted session is gone rather than left as a silent "fix".
    if (orphan !== undefined) expect(await ctx.store.getSession(orphan)).toBeUndefined();

    const retried = await tapFix(app);
    expect(retried.statusCode).toBe(200);
    const body = retried.json<{ sessionId: string; created: boolean }>();
    expect(body.created).toBe(true);
    expect(await ctx.store.repairs.sessionOrigin('p-fix', 'pr:7')).toBe(body.sessionId);
    expect(dispatchTurn).toHaveBeenLastCalledWith(
      body.sessionId,
      expect.stringContaining('Fix pull request #7'),
      undefined,
      expect.objectContaining({ displayPrompt: 'Fix pull request #7' }),
    );

    // Owned now: a further tap opens the same session instead of a second one.
    const again = await tapFix(app);
    expect(again.json()).toEqual({ sessionId: body.sessionId, created: false });
  } finally {
    await app.close();
  }
});
