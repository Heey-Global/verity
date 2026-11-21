import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRecord, SessionRecord } from '@verity/store';
import { WORKTREE_SIDECAR } from './worktree.js';
import { SessionStorage, compareDependencyTrees, storageHold } from './session-storage.js';
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
    execFileSync(
      'git',
      [
        ...(args.includes('push') ? [] : ['-c', 'core.hooksPath=/dev/null']),
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      {
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  const run = (args: string[]) =>
    execFileSync(
      'git',
      [
        ...(args.includes('push') ? [] : ['-c', 'core.hooksPath=/dev/null']),
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      {
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
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
  run(['-C', root, 'worktree', 'lock', '--reason', 'Verity session: managed by server', path]);
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
    /** Time passes while the session keeps working: it is never idle. */
    active: (days: number) => {
      now += days * 86400000;
      activity = now;
    },
    /** Idle for `days`: below three, private dependencies are only slimmed by comparison. */
    idleDays: (days: number) => {
      activity = now - days * 86400000;
    },
  };
}
/** Relayout the fixture as a legacy Documents session whose code is the `code-s` sibling. */
function legacyCodeSibling(f: ReturnType<typeof fixture>): string {
  const code = join(f.root, '.verity-sessions', 'code-s');
  f.run(['-C', f.root, 'worktree', 'unlock', f.path]);
  f.run(['-C', f.root, 'worktree', 'move', f.path, code]);
  f.run(['-C', f.root, 'worktree', 'lock', '--reason', 'Verity session: managed by server', code]);
  f.session.worktree = join(f.root, '.verity-document-sessions', 'view');
  return code;
}
describe('safe session storage reclamation', () => {
  it.each([false, true])(
    'leaves ordinary sessions outside recovery checks (.git file=%s)',
    async (asFile) => {
      const f = fixture();
      rmSync(join(f.root, '.git'), { recursive: true });
      if (asFile) writeFileSync(join(f.root, '.git'), 'gitdir: /unmanaged/metadata');
      await expect(f.service.ensureWorkspace(f.session)).resolves.toBeUndefined();
      expect(existsSync(f.path)).toBe(true);
    },
  );

  it.each(['--assume-unchanged', '--skip-worktree'])(
    'preserves tracked edits hidden by %s',
    async (flag) => {
      const f = fixture();
      f.run(['-C', f.path, 'update-index', flag, '.gitignore']);
      const source = 'local-only-edit\n';
      writeFileSync(join(f.path, '.gitignore'), source);
      await f.service.runOnce();
      expect(f.service.lastReport?.blockers).toContainEqual({
        path: f.path,
        reason: 'Index flags may hide local changes',
      });
      expect(readFileSync(join(f.path, '.gitignore'), 'utf8')).toBe(source);
      expect(existsSync(join(f.path, '.git'))).toBe(true);
    },
  );

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
    expect(f.run(['-C', f.root, 'worktree', 'list', '--porcelain'])).toContain(
      'locked Verity session: managed by server',
    );
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
  it('maps sandbox inventories to host paths and uses clone-relative mutation paths', async () => {
    const f = fixture();
    const service = new SessionStorage({
      ...f.deps,
      gitRoot: '/work',
      withGit: async <T>(p: ProjectRecord, operation: (g: GitOutput) => Promise<T>) =>
        f.deps.withGit(p, (git) =>
          operation(async (args) => {
            const worktree = args.indexOf('worktree');
            if (worktree >= 0 && ['add', 'remove', 'lock', 'unlock'].includes(args[worktree + 1]!))
              expect(args.slice(worktree + 2)).not.toContain(f.path);
            const output = await git(args);
            // Both inventory commands execute inside the sandbox in production.
            const absoluteInventory =
              (args.includes('list') && args.includes('worktree')) ||
              args.includes('--absolute-git-dir');
            return absoluteInventory ? output.replaceAll(f.root, '/work') : output;
          }),
        ),
    });
    service.bind(
      async (_, run) => ({ ran: true, value: await run() }),
      () => false,
    );
    await service.runOnce();
    expect(service.lastReport?.recoveryHolds?.count).toBe(0);
    expect(existsSync(f.path), JSON.stringify(service.lastReport?.blockers)).toBe(false);
    await service.ensureWorkspace(f.session);
    expect(existsSync(f.path)).toBe(true);
  });
  it('maps sandbox Git-directory inventory before evaluating dependency recovery holds', async () => {
    const f = fixture();
    f.idleDays(4);
    const service = new SessionStorage({
      ...f.deps,
      gitRoot: '/work',
      withGit: async <T>(p: ProjectRecord, operation: (g: GitOutput) => Promise<T>) =>
        f.deps.withGit(p, (git) =>
          operation(async (args) => {
            const worktree = args.indexOf('worktree');
            if (worktree >= 0 && ['add', 'remove', 'lock', 'unlock'].includes(args[worktree + 1]!))
              expect(args.slice(worktree + 2)).not.toContain(f.path);
            const output = await git(args);
            // Both inventory commands execute inside the sandbox in production.
            const absoluteInventory =
              (args.includes('list') && args.includes('worktree')) ||
              args.includes('--absolute-git-dir');
            return absoluteInventory ? output.replaceAll(f.root, '/work') : output;
          }),
        ),
    });
    service.bind(
      async (_, run) => ({ ran: true, value: await run() }),
      () => false,
    );
    await service.runOnce();
    expect(service.lastReport?.recoveryHolds?.count).toBe(0);
    expect(service.lastReport?.dependenciesRemoved).toContain(join(f.path, 'node_modules'));
    expect(service.lastReport?.blockers).toEqual([]);
    expect(existsSync(f.path)).toBe(true);
  });
  it('preserves locks set outside the managed worktree lifecycle', async () => {
    const f = fixture();
    f.run(['-C', f.root, 'worktree', 'unlock', f.path]);
    f.run(['-C', f.root, 'worktree', 'lock', '--reason', 'manual protection', f.path]);
    await f.service.runOnce();
    expect(existsSync(f.path)).toBe(true);
    expect(
      f.service.lastReport?.blockers.some((entry) => entry.reason.includes('unknown lock')),
    ).toBe(true);
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
    f.idleDays(1);
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
    missing.idleDays(1);
    rmSync(join(missing.path, 'node_modules', 'dep', 'index.js'));
    await missing.service.runOnce();
    expect(existsSync(join(missing.path, 'node_modules', 'dep'))).toBe(true);
    expect(missing.service.lastReport?.dependenciesRemoved).toEqual([]);
  });
  it('preserves runtime resolution of patched transitive dependencies', async () => {
    const f = fixture();
    f.idleDays(1);
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
  it('preserves customized workspace links when dependency comparison rejects removal', async () => {
    const f = fixture();
    f.idleDays(1);
    for (const root of [f.root, f.path]) {
      writeFileSync(join(root, 'package.json'), '{"workspaces":["packages/*"]}');
      mkdirSync(join(root, 'packages', 'source'), { recursive: true });
      writeFileSync(join(root, 'packages', 'source', 'package.json'), '{"name":"@local/source"}');
      f.run(['-C', root, 'add', 'package.json', 'packages/source/package.json']);
      mkdirSync(join(root, 'node_modules', '@local'), { recursive: true });
    }
    const patch = join(f.dir, 'patched-package');
    mkdirSync(patch);
    symlinkSync(patch, join(f.path, 'node_modules', '@local', 'source'));
    symlinkSync('../../packages/source', join(f.root, 'node_modules', '@local', 'source'));
    await f.service.runOnce();
    expect(f.service.lastReport?.dependenciesRemoved).toEqual([]);
    expect(readlinkSync(join(f.path, 'node_modules', '@local', 'source'))).toBe(patch);
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
    f.idleDays(1);
    writeFileSync(join(f.path, 'node_modules', 'dep', 'index.js'), 'local package patch');
    await f.service.runOnce();
    expect(readFileSync(join(f.path, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe(
      'local package patch',
    );
    f.idleDays(8);
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
  it('skips active sessions and incompatible dependencies but slims recent idle sessions', async () => {
    const f = fixture();
    f.busy();
    await f.service.runOnce();
    expect(existsSync(join(f.path, 'node_modules'))).toBe(true);
    const recent = fixture();
    recent.recent();
    await recent.service.runOnce();
    expect(existsSync(join(recent.path, 'node_modules'))).toBe(false);
    expect(existsSync(join(recent.path, '.git'))).toBe(true);
    expect(recent.service.lastReport?.worktreesRetired).toEqual([]);
    const incompatible = fixture();
    incompatible.idleDays(1);
    writeFileSync(
      join(incompatible.path, 'package.json'),
      '{"dependencies":{"different":"1.0.0"}}',
    );
    await incompatible.service.runOnce();
    expect(existsSync(join(incompatible.path, 'node_modules'))).toBe(true);
  });
  it('rechecks dev server and preview blockers after claiming a recent session', async () => {
    const f = fixture();
    f.recent();
    let blocked = false;
    f.service.bind(
      async (_, run) => {
        blocked = true;
        return { ran: true, value: await run() };
      },
      () => blocked,
    );
    await f.service.runOnce();
    expect(existsSync(join(f.path, 'node_modules'))).toBe(true);
  });
  // Every dependency activation moved the previous installation into the
  // worktree's Git directory and nothing ever removed it: 2.5 GB per session in
  // a monorepo. Activation also rewrites workspace links in the copy, so link
  // targets cannot be what decides; file contents do.
  it('removes preserved dependency copies identical to their central installation', async () => {
    const f = fixture();
    f.recent();
    const identity = 'a'.repeat(64);
    const central = join(f.root, '.git', 'verity-dependencies', identity, 'node_modules');
    mkdirSync(join(central, 'dep'), { recursive: true });
    writeFileSync(join(central, 'dep', 'index.js'), 'shared dependency');
    writeFileSync(join(central, '.verity-install.json'), JSON.stringify({ identity }));
    symlinkSync('../../cache/packages/ws', join(central, 'ws'));
    const preserved = join(f.root, '.git', 'worktrees', 'session', 'verity-dependencies-preserved');
    const copy = (id: string, contents: string, receipt = true) => {
      const path = join(preserved, id);
      mkdirSync(join(path, 'dep'), { recursive: true });
      writeFileSync(join(path, 'dep', 'index.js'), contents);
      if (receipt) writeFileSync(join(path, '.verity-install.json'), JSON.stringify({ identity }));
      symlinkSync('../../../packages/ws', join(path, 'ws'));
      return path;
    };
    const identical = copy('11111111-1111-4111-8111-111111111111', 'shared dependency');
    const patched = copy('22222222-2222-4222-8222-222222222222', 'locally patched');
    const unknown = copy('33333333-3333-4333-8333-333333333333', 'shared dependency', false);
    await f.service.runOnce();
    expect(existsSync(identical)).toBe(false);
    expect(existsSync(patched)).toBe(true);
    expect(existsSync(unknown)).toBe(true);
    expect(f.service.lastReport?.blockers.map((blocker) => blocker.path)).toEqual(
      expect.arrayContaining([patched, unknown]),
    );
  });
  // Root sessions keep their copies: root ignores read-only files.
  it.skipIf(process.getuid?.() === 0)(
    "shares an active session's unchanged dependency files with the sealed inventory",
    async () => {
      const f = fixture();
      f.recent();
      const identity = 'c'.repeat(64);
      const inventory = join(f.root, '.git', 'verity-dependencies', identity);
      for (const base of [join(inventory, 'node_modules'), join(f.path, 'node_modules')]) {
        mkdirSync(join(base, 'dep'), { recursive: true });
        writeFileSync(join(base, 'dep', 'index.js'), 'shared dependency');
        writeFileSync(join(base, '.verity-install.json'), JSON.stringify({ identity }));
      }
      // Only the write bits may differ; the test's umask must not decide that.
      chmodSync(join(inventory, 'node_modules', 'dep', 'index.js'), 0o444);
      chmodSync(join(f.path, 'node_modules', 'dep', 'index.js'), 0o644);
      writeFileSync(join(inventory, 'sealed'), 'v1');
      await f.service.runOnce();
      const ino = (base: string) => statSync(join(base, 'node_modules', 'dep', 'index.js')).ino;
      expect(ino(f.path)).toBe(ino(inventory));
      expect(f.service.lastReport?.sharedDependencyBytes).toBeGreaterThan(0);
    },
  );
  // A server or preview in one session used to defer collection for the whole
  // project, so a project that always had one running never reclaimed anything.
  it('reclaims an idle session while another session of the project is busy', async () => {
    const f = fixture();
    const busy = {
      ...f.session,
      sessionId: 'busy',
      worktree: join(f.root, '.verity-sessions', 'busy'),
    };
    const service = new SessionStorage({ ...f.deps, listSessions: async () => [f.session, busy] });
    const asked: Array<string | null> = [];
    service.bind(
      async (_, operation) => ({ ran: true, value: await operation() }),
      (_, sessionId) => {
        asked.push(sessionId);
        return sessionId === 'busy';
      },
    );
    await service.runOnce();
    expect(existsSync(join(f.path, 'node_modules'))).toBe(false);
    expect(asked).toContain('busy');
    expect(asked).toContain(null);
  });
  it('defers the orphan pass while the project holds it', async () => {
    const f = fixture();
    f.orphan();
    f.service.bind(
      async (_, operation) => ({ ran: true, value: await operation() }),
      (_, sessionId) => sessionId === null,
    );
    await f.service.runOnce();
    f.advance();
    await f.service.runOnce();
    expect(existsSync(f.path)).toBe(true);
  });
  // Lockfiles cannot recover edits inside packages or unreceipted backups.
  // Idle age must not turn that unique recovery data into a deletion candidate.
  it('holds unverifiable private dependencies and preserved copies beyond the idle window', async () => {
    const f = fixture();
    writeFileSync(join(f.path, 'package.json'), '{"dependencies":{"different":"1.0.0"}}');
    writeFileSync(join(f.path, 'node_modules', 'dep', 'index.js'), 'private install');
    const preserved = join(f.root, '.git', 'worktrees', 'session', 'verity-dependencies-preserved');
    const copy = join(preserved, '44444444-4444-4444-8444-444444444444');
    mkdirSync(join(copy, 'dep'), { recursive: true });
    writeFileSync(join(copy, 'dep', 'index.js'), 'earlier install, no receipt');
    f.idleDays(2);
    await f.service.runOnce();
    expect(existsSync(join(f.path, 'node_modules', 'dep'))).toBe(true);
    expect(existsSync(copy)).toBe(true);
    f.idleDays(4);
    await f.service.runOnce();
    expect(existsSync(join(f.path, 'node_modules', 'dep'))).toBe(true);
    expect(existsSync(copy)).toBe(true);
    const marker = join(
      f.root,
      '.git',
      'worktrees',
      'session',
      'verity-dependencies-recovery.json',
    );
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({ count: 2, version: 1 });
    // Source stays; only a week of idleness and a merged pull request retire it.
    expect(existsSync(join(f.path, 'package.json'))).toBe(true);
    expect(f.service.lastReport?.worktreesRetired).toEqual([]);
  });
  it('removes an idle receipt-verified installation but holds a later local edit', async () => {
    const f = fixture();
    const identity = 'd'.repeat(64);
    const central = join(f.root, '.git', 'verity-dependencies', identity, 'node_modules');
    mkdirSync(central, { recursive: true });
    writeFileSync(
      join(f.path, 'node_modules', '.verity-install.json'),
      JSON.stringify({ identity }),
    );
    cpSync(join(f.path, 'node_modules'), central, { recursive: true });
    f.idleDays(4);
    await f.service.runOnce();
    expect(existsSync(join(f.path, 'node_modules', 'dep'))).toBe(false);
    cpSync(central, join(f.path, 'node_modules'), { recursive: true });
    writeFileSync(join(f.path, 'node_modules', 'dep', 'index.js'), 'local patch');
    f.idleDays(30);
    await f.service.runOnce();
    expect(readFileSync(join(f.path, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe(
      'local patch',
    );
    expect(existsSync(f.path)).toBe(true);
    expect(f.service.lastReport?.recoveryHolds?.count).toBe(1);
    expect(f.service.lastReport?.worktreesRetired).toEqual([]);
  });
  // A pass cut short at its budget used to restart from the first session, so
  // the same expensive entries consumed every budget and later ones never ran.
  it('continues after the session a cut-short pass was working on', async () => {
    const f = fixture();
    f.recent();
    const visited: string[] = [];
    const sessions = ['a', 'b', 'c'].map((id) => ({
      ...f.session,
      sessionId: id,
      worktree: join(f.root, '.verity-sessions', id),
    }));
    let stopAt = 'b';
    const service = new SessionStorage({
      ...f.deps,
      listSessions: async () => sessions,
      activity: async (id) => {
        visited.push(id);
        if (id === stopAt) throw new Error('budget');
        return null;
      },
    });
    service.bind(
      async (_, operation) => ({ ran: true, value: await operation() }),
      () => false,
    );
    await service.runOnce().catch(() => undefined);
    expect(visited).toEqual(['a', 'b']);
    visited.length = 0;
    stopAt = '';
    await service.runOnce();
    expect(visited).toEqual(['c', 'a', 'b']);
  });
  // Retired inventories prevent comparison. Time passing cannot establish that
  // a backup contains no unique edits, even after the collector restarts.
  it('keeps unverifiable preserved copies across age limits and collector restarts', async () => {
    const f = fixture();
    f.recent();
    const gitDir = join(f.root, '.git', 'worktrees', 'session');
    const preserved = join(gitDir, 'verity-dependencies-preserved');
    const copy = (id: string, receipt: boolean) => {
      const path = join(preserved, id);
      mkdirSync(join(path, 'dep'), { recursive: true });
      writeFileSync(join(path, 'dep', 'index.js'), 'earlier install with a local patch');
      if (receipt)
        writeFileSync(
          join(path, '.verity-install.json'),
          JSON.stringify({ identity: 'b'.repeat(64) }),
        );
      return path;
    };
    const older = copy('55555555-5555-4555-8555-555555555555', true);
    const unreceipted = copy('66666666-6666-4666-8666-666666666666', false);
    await f.service.runOnce();
    expect(f.service.lastReport?.blockers.map((b) => b.reason)).toEqual(
      expect.arrayContaining([
        'Central installation for preserved dependencies is unavailable',
        'Preserved dependencies have no installation receipt',
      ]),
    );
    f.active(2);
    const newer = copy('77777777-7777-4777-8777-777777777777', true);
    await f.service.runOnce();
    expect([older, unreceipted, newer].map((path) => existsSync(path))).toEqual([true, true, true]);
    f.active(1.5);
    await f.service.runOnce();
    // Both old and newly discovered unverifiable copies remain recovery data.
    expect([older, unreceipted, newer].map((path) => existsSync(path))).toEqual([true, true, true]);
    expect(f.service.lastReport?.dependenciesRemoved).not.toEqual(
      expect.arrayContaining([older, unreceipted]),
    );
    // Source and dependency recovery remain intact.
    expect(existsSync(join(f.path, 'package.json'))).toBe(true);
    const journal = join(gitDir, 'verity-dependencies-preserved.observed.json');
    expect(Object.keys(JSON.parse(readFileSync(journal, 'utf8')) as object)).toEqual([
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
      '77777777-7777-4777-8777-777777777777',
    ]);
    f.active(2);
    await f.service.runOnce();
    expect(existsSync(newer)).toBe(true);
    const restarted = new SessionStorage(f.deps);
    restarted.bind(
      async (_, run) => ({ ran: true, value: await run() }),
      () => false,
    );
    f.active(30);
    await restarted.runOnce();
    expect([older, unreceipted, newer].every(existsSync)).toBe(true);
    expect(restarted.lastReport?.recoveryHolds?.count).toBe(3);
  });
  it('never shortens the preserved-copy window from a corrupt, future or symlinked journal', async () => {
    const f = fixture();
    f.recent();
    const gitDir = join(f.root, '.git', 'worktrees', 'session');
    const copy = join(
      gitDir,
      'verity-dependencies-preserved',
      '88888888-8888-4888-8888-888888888888',
    );
    mkdirSync(join(copy, 'dep'), { recursive: true });
    writeFileSync(join(copy, 'dep', 'index.js'), 'local patch');
    const journal = join(gitDir, 'verity-dependencies-preserved.observed.json');
    const elsewhere = join(f.dir, 'elsewhere.json');
    writeFileSync(elsewhere, JSON.stringify({ '88888888-8888-4888-8888-888888888888': 1 }));
    for (const plant of [
      () => writeFileSync(journal, '{not json'),
      () => symlinkSync(elsewhere, journal),
      () =>
        writeFileSync(
          journal,
          JSON.stringify({ '88888888-8888-4888-8888-888888888888': Date.now() + 365 * 86400000 }),
        ),
    ]) {
      rmSync(journal, { force: true });
      plant();
      await f.service.runOnce();
      expect(existsSync(copy)).toBe(true);
    }
    // The symlinked journal was replaced, never written through.
    expect(JSON.parse(readFileSync(elsewhere, 'utf8'))).toEqual({
      '88888888-8888-4888-8888-888888888888': 1,
    });
    // Observation age never proves that unknown contents are disposable.
    f.active(30);
    await f.service.runOnce();
    expect(existsSync(copy)).toBe(true);
  });
  it('does not mutate preserved copies or their journal in dry-run mode', async () => {
    const f = fixture();
    f.recent();
    const gitDir = join(f.root, '.git', 'worktrees', 'session');
    const copy = join(
      gitDir,
      'verity-dependencies-preserved',
      '99999999-9999-4999-8999-999999999999',
    );
    mkdirSync(copy, { recursive: true });
    const service = new SessionStorage({ ...f.deps, dryRun: true });
    service.bind(
      async (_, operation) => ({ ran: true, value: await operation() }),
      () => false,
    );
    await service.runOnce();
    f.active(4);
    await service.runOnce();
    expect(existsSync(copy)).toBe(true);
    expect(existsSync(join(gitDir, 'verity-dependencies-preserved.observed.json'))).toBe(false);
  });
  // Skipped sessions left no trace: a pass that never reached a session's
  // storage looked exactly like one that found nothing to reclaim.
  it('counts the sessions a pass reached and why it skipped them', async () => {
    const f = fixture();
    const sessions = ['held', 'quiet', 'busy', 's'].map((id) => ({
      ...f.session,
      sessionId: id,
      worktree: id === 's' ? f.path : join(f.root, '.verity-sessions', id),
    }));
    const log = vi.fn();
    const service = new SessionStorage({
      ...f.deps,
      log,
      listSessions: async () => sessions,
      activity: async (id) => (id === 'quiet' ? null : Date.now()),
    });
    service.bind(
      async (id, operation) =>
        id === 'busy' ? { ran: false } : { ran: true, value: await operation() },
      (_, sessionId) => sessionId === 'held',
    );
    await service.runOnce();
    const coverage = { total: 4, visited: 4, held: 1, noActivity: 1, busy: 1 };
    expect(service.lastReport?.sessions).toEqual(coverage);
    expect(log.mock.calls[0]![0]).toMatchObject({ completed: true, sessions: coverage });
  });
  // The daily pass alone reached only what one 60-second budget covers.
  it('continues a pass cut short on its own until one completes', async () => {
    const f = fixture();
    f.recent();
    let failures = 1;
    const passes: boolean[] = [];
    const service = new SessionStorage({
      ...f.deps,
      continueAfterMs: 5,
      log: (summary) => passes.push(summary.completed),
      activity: async () => {
        if (failures-- > 0) throw new Error('budget');
        return Date.now();
      },
    });
    service.bind(
      async (_, operation) => ({ ran: true, value: await operation() }),
      () => false,
    );
    await service.runOnce().catch(() => undefined);
    await vi.waitFor(() => expect(passes).toEqual([false, true]));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(passes).toEqual([false, true]);
    await service.stop();
  });
  it('schedules no continuation after shutdown', async () => {
    const f = fixture();
    const passes: boolean[] = [];
    const service = new SessionStorage({
      ...f.deps,
      continueAfterMs: 5,
      log: (summary) => passes.push(summary.completed),
      activity: async () => {
        // Not awaited: stop() drains this very pass.
        void service.stop();
        throw new Error('stopped');
      },
    });
    service.bind(
      async (_, operation) => ({ ran: true, value: await operation() }),
      () => false,
    );
    await service.runOnce().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(passes).toEqual([false]);
  });
  it('logs one summary per pass with its blockers', async () => {
    const f = fixture();
    f.idleDays(1);
    writeFileSync(join(f.path, 'node_modules', 'dep', 'index.js'), 'local package patch');
    const log = vi.fn();
    const service = new SessionStorage({ ...f.deps, log });
    service.bind(
      async (_, operation) => ({ ran: true, value: await operation() }),
      () => false,
    );
    await service.runOnce();
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]![0]).toMatchObject({
      completed: true,
      dependenciesRemoved: 0,
      topBlockers: expect.arrayContaining([
        { reason: 'Dependency has local edits or no shared copy', count: 1 },
      ]),
    });
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
  it("keeps an unconverted legacy session's code sibling out of the orphan pass", async () => {
    const f = fixture();
    const code = legacyCodeSibling(f);
    f.advance();
    await f.service.runOnce();
    f.advance();
    await f.service.runOnce();
    // Removing it strands the session in its Documents view: nothing recreates it.
    expect(existsSync(code)).toBe(true);
  });
  it('restores an orphan-retired code sibling for the legacy session that owns it', async () => {
    const f = fixture();
    const code = legacyCodeSibling(f);
    f.orphan();
    await f.service.runOnce();
    f.advance();
    await f.service.runOnce();
    expect(existsSync(code)).toBe(false);
    await f.service.ensureWorkspace({ ...f.session, worktree: code });
    expect(existsSync(join(code, '.git'))).toBe(true);
    await expect(
      f.service.ensureWorkspace({ ...f.session, sessionId: 'other', worktree: code }),
    ).resolves.toBeUndefined();
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
    f.idleDays(1);
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

describe('storage shutdown', () => {
  it('cancels active preparation, drains it and admits no new pass', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const mutate = vi.fn(async (_projectId, _sessionId, _operation, signal?: AbortSignal) => {
      entered();
      await new Promise<void>((resolve) =>
        signal!.addEventListener('abort', () => resolve(), { once: true }),
      );
      await held;
    });
    const service = new SessionStorage({
      listProjects: async () => [{ id: 'p', kind: 'github' } as ProjectRecord],
      listSessions: async () => [
        { sessionId: 's', projectId: 'p', worktree: '/unused' } as SessionRecord,
      ],
      activity: async () => Date.now(),
      root: () => '/unused',
      withGit: async () => {
        throw new Error('shutdown must not reach Git');
      },
      pr: async () => null,
      mutate,
    });
    service.bind(
      async (_id, run) => ({ ran: true, value: await run() }),
      () => false,
    );
    const pass = service.runOnce();
    await started;
    let closed = false;
    const closing = service.stop().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish();
    await closing;
    await pass;
    await service.runOnce();
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});

// The mutation the server wraps around each session's pass re-checked the whole
// project for dev servers and previews, so one serving session still held every
// idle worktree of its project even after the pass itself became per session.
describe('storage hold', () => {
  const devServers = {
    hasRunningServers: (projectId: string) => projectId === 'p',
    hasUnverifiedServers: () => false,
    hasRunningSessionServers: (sessionId: string) => sessionId === 'serving',
  };
  const localPreviews = {
    list: (sessionId: string) => (sessionId === 'previewing' ? [{}] : []),
    listProject: () => [{}],
  };
  const hold = (
    sessionId: string | undefined,
    publicShares: { state: string; sessionId?: string | null }[] = [],
  ) => storageHold({ projectId: 'p', sessionId, devServers, localPreviews, publicShares });
  it('holds orphan storage while listener evidence is unavailable', () => {
    expect(
      storageHold({
        projectId: 'p',
        sessionId: undefined,
        devServers: {
          ...devServers,
          hasRunningServers: () => false,
          hasUnverifiedServers: () => true,
        },
        localPreviews: undefined,
        publicShares: [],
      }),
    ).toBe('Managed dev server is active');
  });
  it('holds only the serving session, any project-level share, and the orphan pass', () => {
    expect(hold('idle')).toBeUndefined();
    expect(hold('serving')).toBe('Managed dev server is active');
    expect(hold('previewing')).toBe('Public preview is active');
    expect(hold('idle', [{ state: 'active', sessionId: 'other' }])).toBeUndefined();
    expect(hold('idle', [{ state: 'revoked', sessionId: null }])).toBeUndefined();
    expect(hold('idle', [{ state: 'active', sessionId: null }])).toBe('Public preview is active');
    expect(hold(undefined)).toBe('Managed dev server is active');
  });
});
