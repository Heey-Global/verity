import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { Conductor } from '@verity/session';
import { createTestDb } from '@verity/store/testing';
import { expect, it, vi } from 'vitest';
import { registerSessionIsolationMigrationRoute } from './session-isolation-migration-route.js';
import { assertIndependentSessionClone } from './session-clone.js';

it('requires an idle session, stops its processes and switches only after a backed-up private clone exists', async () => {
  const ctx = await createTestDb();
  const temp = mkdtempSync(join(tmpdir(), 'verity-migrate-route-'));
  const app = Fastify();
  try {
    const source = join(temp, 'source');
    const checkout = join(source, '.verity-sessions', 'agent-session');
    mkdirSync(source);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', source, ...args], { stdio: 'ignore' });
    git('init', '-b', 'main');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'initial',
    );
    git('worktree', 'add', checkout, '-b', 'session');
    const project = await ctx.store.upsertProject({
      id: 'project',
      owner: 'local',
      repo: 'project',
      kind: 'local',
      containerName: 'project',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 'session',
      projectId: project.id,
      worktree: checkout,
      model: 'test',
    });
    const conductor = new Conductor({ store: ctx.store });
    const stop = vi.fn(() => Promise.resolve());
    const relocate = vi.fn(async (_id: string, old: string, next: string) => {
      expect(old).toBe(checkout);
      await assertIndependentSessionClone(next);
      return true;
    });
    registerSessionIsolationMigrationRoute(app, {
      eventStore: ctx.store,
      conductor,
      backupRoot: join(temp, 'backups'),
      privateCloneRoot: () => join(temp, '.verity-session-clones', project.id),
      stopSessionProcesses: stop,
      relocateSessionWorkspace: relocate,
    });
    let release: (() => void) | undefined;
    const busy = conductor.runExclusive(
      'session',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const denied = await app.inject({ method: 'POST', url: '/sessions/session/isolation/migrate' });
    expect(denied.statusCode).toBe(409);
    expect(stop).not.toHaveBeenCalled();
    release?.();
    await busy;
    const originalGitLink = readFileSync(join(checkout, '.git'), 'utf8');
    relocate.mockResolvedValueOnce(false);
    const interrupted = await app.inject({
      method: 'POST',
      url: '/sessions/session/isolation/migrate',
    });
    expect(interrupted.statusCode).toBe(500);
    const migrated = await app.inject({
      method: 'POST',
      url: '/sessions/session/isolation/migrate',
    });
    expect(migrated.statusCode).toBe(200);
    expect(stop).toHaveBeenCalledWith('session');
    expect(relocate).toHaveBeenCalledTimes(2);
    const result = migrated.json<{ worktree: string; backupPath: string }>();
    expect(result.worktree).toBe(join(temp, '.verity-session-clones', project.id, 'agent-session'));
    expect(result.backupPath).toContain(join(temp, 'backups', 'session'));
    expect(readFileSync(join(checkout, '.git'), 'utf8')).toBe(originalGitLink);
  } finally {
    await app.close();
    await ctx.close();
    rmSync(temp, { recursive: true, force: true });
  }
});
