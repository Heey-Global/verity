import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectRecord, SessionRecord } from '@verity/store';
import { WORKTREE_SIDECAR } from './worktree.js';
import { SessionStorage, compareDependencyTrees } from './session-storage.js';
import type { GitOutput } from './branches.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'verity-storage-'));
  dirs.push(dir);
  const root = join(dir, 'repo'),
    remote = join(dir, 'remote.git');
  const git: GitOutput = async (args) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const run = (args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  run(['init', '-q', '-b', 'main', root]);
  run(['-C', root, 'config', 'user.email', 'test@example.invalid']);
  run(['-C', root, 'config', 'user.name', 'Test']);
  writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}');
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
  writeFileSync(
    join(root, '.gitignore'),
    'node_modules/\n.verity-sessions/\n.verity-storage/\nsecret.txt\n',
  );
  run(['-C', root, 'add', '.']);
  run(['-C', root, 'commit', '-qm', 'initial']);
  run(['init', '-q', '--bare', remote]);
  run(['-C', root, 'remote', 'add', 'origin', remote]);
  run(['-C', root, 'push', '-q', 'origin', 'main']);
  const path = join(root, '.verity-sessions', 'session');
  run(['-C', root, 'worktree', 'add', '-qb', 'session', path, 'main']);
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'shared dependency');
  cpSync(join(root, 'node_modules'), join(path, 'node_modules'), { recursive: true });
  const session = { sessionId: 's', projectId: 'p', worktree: path } as SessionRecord;
  const project = { id: 'p', kind: 'github', state: 'active' } as ProjectRecord;
  let sessions = [session],
    now = Date.now(),
    activity = now - 8 * 86400000,
    busy = false;
  const deps = {
    listProjects: async () => [project],
    listSessions: async () => sessions,
    activity: async () => activity,
    root: () => root,
    withGit: async <T>(_: ProjectRecord, operation: (g: GitOutput) => Promise<T>) => operation(git),
    mutate: async (_: string, __: string | undefined, operation: () => Promise<void>) =>
      operation(),
    pr: async () => ({ phase: 'merged' }),
    now: () => now,
  };
  const service = new SessionStorage(deps);
  service.bind(
    async (_, operation) => (busy ? { ran: false } : { ran: true, value: await operation() }),
    () => false,
  );
  return {
    dir,
    root,
    path,
    service,
    session,
    deps,
    run,
    orphan: () => {
      sessions = [];
    },
    advance: () => {
      now += 8 * 86400000;
    },
    busy: () => {
      busy = true;
    },
    recent: () => {
      activity = now;
    },
  };
}
describe('safe session storage reclamation', () => {
  it('retires a saved clean session and restores its exact branch on resume', async () => {
    const f = fixture();
    await f.service.runOnce();
    expect(existsSync(f.path)).toBe(false);
    expect(f.service.lastReport?.worktreesRetired).toEqual([f.path]);
    expect(await f.service.canRestore(f.session)).toBe(true);
    expect(await f.service.canRestore({ ...f.session, sessionId: 'wrong' })).toBe(false);
    await f.service.ensureWorkspace(f.session);
    expect(await f.service.canRestore(f.session)).toBe(false);
    expect(existsSync(join(f.path, 'package.json'))).toBe(true);
    expect(f.run(['-C', f.path, 'branch', '--show-current']).trim()).toBe('session');
    await f.service.ensureWorkspace(f.session); // Recovery is idempotent.
  });
  it('refuses corrupt and symlinked recovery journals without recreating worktrees', async () => {
    const f = fixture();
    await f.service.runOnce();
    const directory = join(f.root, '.git', 'verity-storage');
    const journal = join(
      directory,
      readdirSync(directory).find((name) => name.startsWith('retired-'))!,
    );
    const source = readFileSync(journal, 'utf8');
    writeFileSync(journal, 'null');
    expect(await f.service.canRestore(f.session)).toBe(false);
    writeFileSync(journal, source);
    const outside = join(f.dir, 'journal.json');
    writeFileSync(outside, source);
    rmSync(journal);
    symlinkSync(outside, journal);
    expect(await f.service.canRestore(f.session)).toBe(false);
    await expect(f.service.ensureWorkspace(f.session)).rejects.toThrow('Unsafe');
    expect(existsSync(f.path)).toBe(false);
  });
  it('does not follow dependency-input or sidecar symlinks', async () => {
    const f = fixture();
    const outside = join(f.dir, 'outside');
    writeFileSync(outside, 'private marker');
    rmSync(join(f.path, 'package.json'));
    symlinkSync(outside, join(f.path, 'package.json'));
    await f.service.runOnce();
    expect(f.service.lastReport?.blockers.some((entry) => entry.reason.includes('symlink'))).toBe(
      true,
    );
    expect(JSON.stringify(f.service.lastReport)).not.toContain('private marker');
    const sidecar = fixture();
    symlinkSync(outside, join(sidecar.path, WORKTREE_SIDECAR));
    await sidecar.service.runOnce();
    expect(sidecar.service.lastReport?.worktreesRetired).toEqual([]);
    expect(existsSync(sidecar.path)).toBe(true);
  });
  it('preserves matching relative links with different source targets and local file deletions', async () => {
    const f = fixture();
    for (const root of [f.root, f.path]) {
      mkdirSync(join(root, 'vendor', 'dep'), { recursive: true });
      writeFileSync(
        join(root, 'vendor', 'dep', 'index.js'),
        root === f.path ? 'patched' : 'shared',
      );
      symlinkSync('../vendor/dep', join(root, 'node_modules', 'linked'));
    }
    await f.service.runOnce();
    expect(readlinkSync(join(f.path, 'node_modules', 'linked'))).toBe('../vendor/dep');
    const missing = fixture();
    rmSync(join(missing.path, 'node_modules', 'dep', 'index.js'));
    await missing.service.runOnce();
    expect(existsSync(join(missing.path, 'node_modules', 'dep'))).toBe(true);
    expect(missing.service.lastReport?.dependenciesRemoved).toEqual([]);
  });
  it('preserves runtime resolution of patched transitive dependencies', async () => {
    const f = fixture();
    for (const root of [f.root, f.path]) {
      for (const name of ['a', 'b'])
        mkdirSync(join(root, 'node_modules', name), { recursive: true });
      writeFileSync(join(root, 'node_modules', 'a', 'index.js'), "module.exports = require('b');");
      writeFileSync(join(root, 'node_modules', 'b', 'index.js'), "module.exports = 'shared';");
    }
    writeFileSync(join(f.path, 'node_modules', 'b', 'index.js'), "module.exports = 'patched';");
    await f.service.runOnce();
    expect(createRequire(join(f.path, 'caller.cjs'))('a')).toBe('patched');
    expect(existsSync(join(f.path, 'node_modules', 'a'))).toBe(true);
  });
  it('retains nested dependencies outside ancestor resolution', async () => {
    const f = fixture();
    for (const root of [f.root, f.path]) {
      mkdirSync(join(root, 'apps', 'example', 'node_modules', 'nested'), { recursive: true });
      writeFileSync(join(root, 'apps', 'example', 'node_modules', 'nested', 'index.js'), 'nested');
    }
    await f.service.runOnce();
    expect(
      readFileSync(join(f.path, 'apps', 'example', 'node_modules', 'nested', 'index.js'), 'utf8'),
    ).toBe('nested');
  });
  it('repairs private workspace source links after rejected retirement', async () => {
    const f = fixture();
    for (const root of [f.root, f.path]) {
      writeFileSync(join(root, 'package.json'), '{"workspaces":["packages/*"]}');
      mkdirSync(join(root, 'packages', 'source'), { recursive: true });
      writeFileSync(join(root, 'packages', 'source', 'package.json'), '{"name":"@local/source"}');
      f.run(['-C', root, 'add', 'package.json', 'packages/source/package.json']);
    }
    const service = new SessionStorage({
      ...f.deps,
      pr: async () => {
        throw new Error('PR unavailable');
      },
    });
    service.bind(
      async (_, run) => ({ ran: true, value: await run() }),
      () => false,
    );
    await service.runOnce();
    expect(
      service.lastReport?.blockers.some((entry) => entry.reason.includes('PR unavailable')),
    ).toBe(true);
    expect(readlinkSync(join(f.path, 'node_modules', '@local', 'source'))).toBe(
      '../../packages/source',
    );
  });
  it('protects modified packages, uncommitted source, unknown ignored files and unsaved commits', async () => {
    const f = fixture();
    writeFileSync(join(f.path, 'node_modules', 'dep', 'index.js'), 'local package patch');
    await f.service.runOnce();
    expect(readFileSync(join(f.path, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe(
      'local package patch',
    );
    writeFileSync(join(f.path, 'node_modules', 'dep', 'index.js'), 'shared dependency');
    writeFileSync(join(f.path, 'secret.txt'), 'local-only data');
    await f.service.runOnce();
    expect(existsSync(join(f.path, 'secret.txt'))).toBe(true);
    expect(existsSync(join(f.path, 'node_modules'))).toBe(false);
    rmSync(join(f.path, 'secret.txt'));
    writeFileSync(join(f.path, 'source.txt'), 'unpushed work');
    f.run(['-C', f.path, 'add', 'source.txt']);
    f.run(['-C', f.path, 'commit', '-qm', 'local work']);
    await f.service.runOnce();
    expect(existsSync(join(f.path, 'source.txt'))).toBe(true);
    expect(f.service.lastReport?.blockers.some((b) => b.reason.includes('verified remote'))).toBe(
      true,
    );
  });
  it('skips active sessions, recent sessions and incompatible dependencies', async () => {
    const f = fixture();
    f.busy();
    await f.service.runOnce();
    expect(existsSync(join(f.path, 'node_modules'))).toBe(true);
    const recent = fixture();
    recent.recent();
    await recent.service.runOnce();
    expect(existsSync(join(recent.path, 'node_modules'))).toBe(true);
    const incompatible = fixture();
    writeFileSync(
      join(incompatible.path, 'package.json'),
      '{"dependencies":{"different":"1.0.0"}}',
    );
    await incompatible.service.runOnce();
    expect(existsSync(join(incompatible.path, 'node_modules'))).toBe(true);
  });
  it('requires a persistent orphan grace period', async () => {
    const f = fixture();
    f.orphan();
    await f.service.runOnce();
    expect(existsSync(f.path)).toBe(true);
    f.advance();
    await f.service.runOnce();
    expect(existsSync(f.path)).toBe(false);
  });
  it('does not mutate in dry-run mode', async () => {
    const f = fixture();
    const service = new SessionStorage({ ...f.deps, dryRun: true });
    service.bind(
      async (_, operation) => ({ ran: true, value: await operation() }),
      () => false,
    );
    await service.runOnce();
    expect(existsSync(join(f.path, 'node_modules', 'dep', 'index.js'))).toBe(true);
    expect(existsSync(join(f.root, '.git', 'verity-storage'))).toBe(false);
  });
  it('never follows symlink targets while comparing disposable dependencies', async () => {
    const f = fixture();
    symlinkSync('/outside', join(f.path, 'node_modules', 'unknown'));
    await expect(
      compareDependencyTrees(
        join(f.path, 'node_modules'),
        join(f.root, 'node_modules'),
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow();
    await f.service.runOnce();
    expect(readlinkSync(join(f.path, 'node_modules', 'unknown'))).toBe('/outside');
  });
  it('recovers a journal when removal completed just before a failure', async () => {
    const f = fixture();
    const service = new SessionStorage({
      ...f.deps,
      withGit: async <T>(p: ProjectRecord, operation: (g: GitOutput) => Promise<T>) =>
        f.deps.withGit(p, (git) =>
          operation(async (args) => {
            const result = await git(args);
            if (args.includes('remove')) throw new Error('interrupted');
            return result;
          }),
        ),
    });
    service.bind(
      async (_, operation) => ({ ran: true, value: await operation() }),
      () => false,
    );
    await service.runOnce();
    expect(existsSync(f.path)).toBe(false);
    await f.service.ensureWorkspace(f.session);
    expect(existsSync(f.path)).toBe(true);
  });
});
