import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import type { GitRunner } from './provisioner.js';
import { createProvisioner, fakeDocker, fakeGit } from './provisioner.test-helper.js';

// Repair of a managed clone whose shared `.git/config` carries a `core.worktree`: the
// guard in clone-config-guard.ts, driven through the provisioner's clone phase with real
// git, and the failure state and step names the clone phase leaves behind.

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
});

const baseInput = {
  owner: 'example-org',
  repo: 'example-repo',
  containerName: 'dev-example-org-example-repo',
  state: 'absent' as const,
};

async function seedProject(state: 'absent' | 'failed' = 'absent'): Promise<string> {
  const id = randomUUID();
  await ctx.store.upsertProject({ id, ...baseInput, state });
  return id;
}

describe('provisioner clone phase: shared clone config', () => {
  describe('Repair of a clone whose shared config names a session worktree', () => {
    const hermetic = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    };
    const run = (...args: string[]): string =>
      execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
        encoding: 'utf8',
        env: hermetic,
        cwd: '/',
      });

    /** A real clone of a real remote, with one live session worktree holding uncommitted
     *  work, and the server's git runner: real git for everything but the network probe. */
    function cloneWithSession(): {
      root: string;
      clone: string;
      session: string;
      config: string;
      git: GitRunner;
      calls: string[][];
    } {
      const root = mkdtempSync(join(tmpdir(), 'verity-worktree-config-'));
      const remote = join(root, 'remote');
      run('init', '-q', '-b', 'main', remote);
      writeFileSync(join(remote, 'file.txt'), 'remote\n');
      run('-C', remote, 'add', 'file.txt');
      run('-C', remote, 'commit', '-qm', 'initial');
      const clone = join(root, 'example-org-example-repo');
      run('clone', '-q', remote, clone);
      run('-C', clone, 'worktree', 'add', '-q', '.verity-sessions/agent-x', '-b', 'agent-x');
      const session = join(clone, '.verity-sessions', 'agent-x');
      writeFileSync(join(session, 'file.txt'), 'uncommitted session edit\n');
      writeFileSync(join(session, 'wip.txt'), 'untracked session work\n');
      const calls: string[][] = [];
      const git: GitRunner = async (args) => {
        calls.push([...args]);
        if (args.includes('ls-remote'))
          return { stdout: `${'a'.repeat(40)}\trefs/heads/main\n`, stderr: '' };
        return { stdout: run(...args), stderr: '' };
      };
      return { root, clone, session, config: join(clone, '.git', 'config'), git, calls };
    }

    it('removes only the session-worktree core.worktree, keeps a backup and leaves the session untouched', async () => {
      const f = cloneWithSession();
      try {
        // The incident shape: the value names a session as the Sandbox mounts it.
        run('config', '--file', f.config, 'core.worktree', '/work/.verity-sessions/agent-x');
        const contaminated = readFileSync(f.config);
        const sessionHead = run('-C', f.session, 'rev-parse', 'HEAD');
        const id = await seedProject('failed');
        const repaired: unknown[] = [];
        const provisioner = createProvisioner({
          store: ctx.store,
          db: ctx.db,
          docker: fakeDocker().client,
          defaultImageRef: 'default',
          hostCloneRoot: f.root,
          projectTokenMint: async () => 'tok',
          git: f.git,
          cloneConfigBackupDirectory: join(f.root, 'backups'),
          onCloneConfigRepaired: (event) => repaired.push(event),
        });

        const result = await provisioner.provision(id);

        expect(result.state).toBe('active');
        expect(() => run('config', '--file', f.config, '--get', 'core.worktree')).toThrow();
        expect(repaired).toEqual([
          expect.objectContaining({
            projectId: id,
            file: f.config,
            previousValue: '/work/.verity-sessions/agent-x',
          }),
        ]);
        const [backup] = readdirSync(join(f.root, 'backups'));
        expect(readFileSync(join(f.root, 'backups', backup!))).toEqual(contaminated);
        // The session's working tree, its untracked work and its branch are exactly as before.
        expect(readFileSync(join(f.session, 'file.txt'), 'utf8')).toBe(
          'uncommitted session edit\n',
        );
        expect(readFileSync(join(f.session, 'wip.txt'), 'utf8')).toBe('untracked session work\n');
        expect(run('-C', f.session, 'rev-parse', 'HEAD')).toBe(sessionHead);
        // The reset that followed was pinned to the main checkout.
        const reset = f.calls.find((call) => call.includes('reset'));
        expect(reset).toContain(`--work-tree=${f.clone}`);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    });

    it('relies on --work-tree beating a resolvable core.worktree (git behaviour pin)', async () => {
      const f = cloneWithSession();
      try {
        // The provisioner's reset carries `--work-tree` (asserted above). This pins the git
        // behaviour that makes it safe: with a value that resolves on this host, the pinned
        // reset leaves the session alone, while an unpinned one overwrites its edit.
        run('config', '--file', f.config, 'core.worktree', f.session);
        run('-C', f.clone, `--work-tree=${f.clone}`, 'reset', '--hard', 'origin/main');
        expect(readFileSync(join(f.session, 'file.txt'), 'utf8')).toBe(
          'uncommitted session edit\n',
        );
        // ...whereas git without the pin really would write there.
        run('-C', f.clone, 'reset', '--hard', 'origin/main');
        expect(readFileSync(join(f.session, 'file.txt'), 'utf8')).toBe('remote\n');
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    });

    it('stops with the file and value, and changes nothing, for a core.worktree it cannot place', async () => {
      const f = cloneWithSession();
      try {
        run('config', '--file', f.config, 'core.worktree', '/srv/somewhere-else');
        const before = readFileSync(f.config);
        const id = await seedProject('failed');
        const provisioner = createProvisioner({
          store: ctx.store,
          db: ctx.db,
          docker: fakeDocker().client,
          defaultImageRef: 'default',
          hostCloneRoot: f.root,
          projectTokenMint: async () => 'tok',
          git: f.git,
          cloneConfigBackupDirectory: join(f.root, 'backups'),
        });

        await expect(provisioner.provision(id)).rejects.toThrow(
          /repository config invalid: .*\.git\/config sets core\.worktree outside the clone root \(\/srv\/somewhere-else\)/,
        );

        expect(readFileSync(f.config)).toEqual(before);
        expect(existsSync(join(f.root, 'backups'))).toBe(false);
        expect(f.calls.some((call) => call.includes('fetch') || call.includes('reset'))).toBe(
          false,
        );
        // The row records why, instead of staying in `cloning` as an update that never ends.
        const project = await ctx.store.getProject(id);
        expect(project?.state).toBe('failed');
        expect(project?.provisionError).toMatch(/^repository config invalid: /);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    });

    it('clears the shared and the per-worktree config in one Repair', async () => {
      const f = cloneWithSession();
      try {
        run('config', '--file', f.config, 'core.worktree', '/work/.verity-sessions/agent-x');
        run('config', '--file', f.config, 'extensions.worktreeConfig', 'true');
        const perWorktree = join(f.clone, '.git', 'config.worktree');
        run('config', '--file', perWorktree, 'core.worktree', '/work/.verity-sessions/agent-y');
        const id = await seedProject('failed');
        const repaired: unknown[] = [];
        const provisioner = createProvisioner({
          store: ctx.store,
          db: ctx.db,
          docker: fakeDocker().client,
          defaultImageRef: 'default',
          hostCloneRoot: f.root,
          projectTokenMint: async () => 'tok',
          git: f.git,
          cloneConfigBackupDirectory: join(f.root, 'backups'),
          onCloneConfigRepaired: (event) => repaired.push(event),
        });

        expect((await provisioner.provision(id)).state).toBe('active');
        expect(repaired).toHaveLength(2);
        expect(readdirSync(join(f.root, 'backups'))).toHaveLength(2);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    });

    it('names the config check when the backup cannot be written, and keeps the key', async () => {
      const f = cloneWithSession();
      try {
        run('config', '--file', f.config, 'core.worktree', '/work/.verity-sessions/agent-x');
        const blocked = join(f.root, 'not-a-directory');
        writeFileSync(blocked, '');
        const id = await seedProject('failed');
        const provisioner = createProvisioner({
          store: ctx.store,
          db: ctx.db,
          docker: fakeDocker().client,
          defaultImageRef: 'default',
          hostCloneRoot: f.root,
          projectTokenMint: async () => 'tok',
          git: f.git,
          cloneConfigBackupDirectory: join(blocked, 'backups'),
        });

        await expect(provisioner.provision(id)).rejects.toThrow(
          /^repository config check failed: /,
        );
        expect(run('config', '--file', f.config, '--get', 'core.worktree').trim()).toBe(
          '/work/.verity-sessions/agent-x',
        );
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    });

    it('lists the finding as a Repair warning before anything changes', async () => {
      const f = cloneWithSession();
      try {
        run('config', '--file', f.config, 'core.worktree', '/work/.verity-sessions/agent-x');
        const before = readFileSync(f.config);
        const id = await seedProject('failed');
        const provisioner = createProvisioner({
          store: ctx.store,
          db: ctx.db,
          docker: fakeDocker().client,
          defaultImageRef: 'default',
          hostCloneRoot: f.root,
          git: f.git,
        });

        const warnings = await provisioner.provisionWarnings(id);

        expect(warnings).toEqual([expect.stringContaining('/work/.verity-sessions/agent-x')]);
        expect(readFileSync(f.config)).toEqual(before);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    });
  });

  it('names the git step that failed instead of calling every clone-phase failure a clone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-clone-step-'));
    try {
      mkdirSync(join(root, 'example-org-example-repo', '.git'), { recursive: true });
      const id = await seedProject('absent');
      const { runner: git } = fakeGit([{ match: /fetch origin/, reject: true }]);
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker: fakeDocker().client,
        defaultImageRef: 'default',
        hostCloneRoot: root,
        projectTokenMint: async () => 'tok',
        git,
      });

      await expect(provisioner.provision(id)).rejects.toThrow(/^git fetch failed: /);
      expect((await ctx.store.getProject(id))?.provisionError).toMatch(/^git fetch failed: /);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
