import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRecord, SessionRecord } from '@verity/store';
import {
  CodeWorkspaceUnavailableError,
  describeCodeWorkspaceFailure,
  createCodeWorkspaceRecovery,
  type CodeWorkspaceRecoveryDeps,
} from './code-workspace-recovery.js';
import { createGitWorktreeProvisioner } from './worktree.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
// Fresh fixture repositories have no hooks and global config is off. A push must not
// carry a hooks override at all: the sandbox git guard refuses every such push.
const git = (args: string[]) =>
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

interface Move {
  source_worktree: string;
  target_worktree: string;
  result_json: string | null;
  notice: string;
}

function fixture(options: { dataRoot?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'verity-code-recovery-'));
  dirs.push(dir);
  const cloneRoot = join(dir, 'clones');
  const clone = join(cloneRoot, 'o-r');
  const remote = join(dir, 'remote.git');
  git(['init', '-q', '-b', 'main', clone]);
  git(['-C', clone, 'config', 'user.email', 'test@example.invalid']);
  git(['-C', clone, 'config', 'user.name', 'Test']);
  writeFileSync(join(clone, 'README.md'), 'base\n');
  writeFileSync(join(clone, '.gitignore'), '.verity-sessions/\n.verity-document-sessions/\n');
  git(['-C', clone, 'add', '.']);
  git(['-C', clone, 'commit', '-qm', 'initial']);
  git(['init', '-q', '--bare', remote]);
  git(['-C', clone, 'remote', 'add', 'origin', remote]);
  git(['-C', clone, 'push', '-q', 'origin', 'main']);
  const view = join(clone, '.verity-document-sessions', 'view');
  mkdirSync(view, { recursive: true });
  const target = join(clone, '.verity-sessions', 'code-s');
  const project = {
    id: 'p',
    owner: 'o',
    repo: 'r',
    kind: 'github',
    state: 'active',
    cloneDir: null,
  } as unknown as ProjectRecord;
  let session = { sessionId: 's', projectId: 'p', worktree: view } as SessionRecord;
  const moves = new Map<string, Move>();
  const backends = vi.fn(async () => undefined);
  let busy = false;
  const deps: CodeWorkspaceRecoveryDeps = {
    store: {
      getSession: async () => session,
      getProject: async () => project,
      getSessionMove: async (_: string, op: string) => moves.get(op) as never,
      sessionMoves: {
        prepareRelayout: async (input) => {
          if (!moves.has(input.operationId))
            moves.set(input.operationId, {
              source_worktree: input.sourceWorktree,
              target_worktree: input.targetWorktree,
              result_json: null,
              notice: '',
            });
        },
        commitRelayout: async (_, op, notice, result) => {
          const move = moves.get(op)!;
          if (move.result_json !== null) return;
          if (session.worktree !== move.source_worktree) throw new Error('changed');
          Object.assign(move, { notice, result_json: result });
          session = { ...session, worktree: move.target_worktree };
        },
      },
    },
    cloneRoot,
    dataRoot: options.dataRoot ? join(dir, 'data') : undefined,
    defaultBranch: async () => 'main',
    worktrees: (_, repoDir, opts) =>
      createGitWorktreeProvisioner({
        repoDir,
        worktreeRoot: join(repoDir, '.verity-sessions'),
        ...opts,
        git: async (args) => void git([...args]),
      }),
    ensureWorkspace: vi.fn(async () => undefined),
    claimIdle: async (_, fn) => (busy ? { ran: false } : { ran: true, value: await fn() }),
    closeBackends: backends,
    git: async (args) => git([...args]),
  };
  return {
    dir,
    clone,
    view,
    target,
    deps,
    moves,
    backends,
    session: () => session,
    busy: () => {
      busy = true;
    },
  };
}

const head = (path: string) => git(['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD']).trim();

describe('legacy Documents session conversion', () => {
  it('adopts an existing code worktree unchanged, unpushed work included', async () => {
    const f = fixture();
    git(['-C', f.clone, 'worktree', 'add', '-qb', 'code-s', f.target, 'main']);
    writeFileSync(join(f.target, 'draft.ts'), 'unpushed\n');
    const result = await createCodeWorkspaceRecovery(f.deps).convert('s');
    expect(result).toMatchObject({ worktree: f.target, branch: 'code-s', source: 'adopted' });
    expect(readFileSync(join(f.target, 'draft.ts'), 'utf8')).toBe('unpushed\n');
    expect(f.session().worktree).toBe(f.target);
    // A native thread remembers the Documents view as its working directory.
    expect(f.backends).toHaveBeenCalledWith('s');
    expect([...f.moves.values()][0]?.notice).toContain('/work/.verity-sessions/code-s');
    expect(existsSync(f.view)).toBe(true);
  });

  it('restores a retired checkout through its journal before anything else', async () => {
    const f = fixture();
    vi.mocked(f.deps.ensureWorkspace).mockImplementation(async (session) => {
      git(['-C', f.clone, 'worktree', 'add', '-qb', 'code-s', session.worktree, 'main']);
    });
    const result = await createCodeWorkspaceRecovery(f.deps).convert('s');
    expect(f.deps.ensureWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's', worktree: f.target }),
    );
    expect(result?.source).toBe('journal');
  });

  it('checks out a surviving local branch instead of starting over', async () => {
    const f = fixture();
    git(['-C', f.clone, 'branch', 'code-s', 'main']);
    const result = await createCodeWorkspaceRecovery(f.deps).convert('s');
    expect(result?.source).toBe('branch');
    expect(head(f.target)).toBe('code-s');
  });

  it('starts the branch from origin when only the pushed copy remains', async () => {
    const f = fixture();
    git(['-C', f.clone, 'checkout', '-qb', 'code-s']);
    writeFileSync(join(f.clone, 'pushed.ts'), 'pushed\n');
    git(['-C', f.clone, 'add', 'pushed.ts']);
    git(['-C', f.clone, 'commit', '-qm', 'pushed']);
    git(['-C', f.clone, 'push', '-q', 'origin', 'code-s']);
    git(['-C', f.clone, 'checkout', '-q', 'main']);
    git(['-C', f.clone, 'branch', '-D', 'code-s']);
    const result = await createCodeWorkspaceRecovery(f.deps).convert('s');
    expect(result?.source).toBe('origin');
    expect(readFileSync(join(f.target, 'pushed.ts'), 'utf8')).toBe('pushed\n');
  });

  it('creates a fresh checkout only when no trace of the old one remains', async () => {
    const f = fixture();
    const result = await createCodeWorkspaceRecovery(f.deps).convert('s');
    expect(result).toMatchObject({ source: 'fresh', branch: 'code-s' });
    expect(head(f.target)).toBe('code-s');
  });

  it('refuses to take over a path that is not the session checkout', async () => {
    const f = fixture();
    mkdirSync(f.target, { recursive: true });
    writeFileSync(join(f.target, 'keep.txt'), 'someone else\n');
    await expect(createCodeWorkspaceRecovery(f.deps).convert('s')).rejects.toThrow(
      CodeWorkspaceUnavailableError,
    );
    expect(readFileSync(join(f.target, 'keep.txt'), 'utf8')).toBe('someone else\n');
    expect(f.session().worktree).toBe(f.view);
  });

  it('refuses a separate repository at the checkout path', async () => {
    const f = fixture();
    // Its own repository, not a worktree of the clone: commits would go elsewhere.
    git(['init', '-q', '-b', `code-s`, f.target]);
    await expect(createCodeWorkspaceRecovery(f.deps).convert('s')).rejects.toThrow(
      CodeWorkspaceUnavailableError,
    );
    expect(f.session().worktree).toBe(f.view);
  });

  it('is idempotent and leaves code sessions alone', async () => {
    const f = fixture();
    const recovery = createCodeWorkspaceRecovery(f.deps);
    const first = await recovery.convert('s');
    expect(await recovery.convert('s')).toBeNull();
    expect(f.session().worktree).toBe(first?.worktree);
  });

  it('waits for a running turn instead of converting under it', async () => {
    const f = fixture();
    f.busy();
    const recovery = createCodeWorkspaceRecovery(f.deps);
    await expect(recovery.convert('s')).rejects.toMatchObject({ reason: 'busy' });
    await expect(recovery.beforeTurn('s')).resolves.toBeUndefined();
    expect(f.session().worktree).toBe(f.view);
  });

  it('fails a turn visibly when the code workspace cannot be restored', async () => {
    const f = fixture();
    mkdirSync(f.target, { recursive: true });
    await expect(createCodeWorkspaceRecovery(f.deps).beforeTurn('s')).rejects.toMatchObject({
      code: 'code_workspace_unavailable',
      reason: 'unrecoverable',
    });
  });

  it('publishes the old view so the new Documents copy starts from it', async () => {
    const f = fixture({ dataRoot: true });
    writeFileSync(join(f.view, 'notes.md'), 'kept\n');
    await createCodeWorkspaceRecovery(f.deps).convert('s');
    const next = join(f.clone, '.verity-document-sessions', 'code-s');
    expect(readFileSync(join(next, 'notes.md'), 'utf8')).toBe('kept\n');
    expect(readFileSync(join(f.view, 'notes.md'), 'utf8')).toBe('kept\n');
  });

  it('restores a missing ordinary checkout from its journal, or says it cannot', async () => {
    const f = fixture();
    const recovery = createCodeWorkspaceRecovery(f.deps);
    await recovery.convert('s');
    rmSync(f.target, { recursive: true, force: true });
    await expect(recovery.restore('s')).rejects.toThrow('has no recovery record');
    vi.mocked(f.deps.ensureWorkspace).mockImplementation(async (session) => {
      mkdirSync(session.worktree, { recursive: true });
    });
    await expect(recovery.restore('s')).resolves.toMatchObject({
      restored: true,
      source: 'journal',
    });
    expect(existsSync(f.target)).toBe(true);
    // A turn's own journal restore can win the race and fail this one; the checkout is back.
    rmSync(f.target, { recursive: true, force: true });
    vi.mocked(f.deps.ensureWorkspace).mockImplementation(async (session) => {
      mkdirSync(session.worktree, { recursive: true });
      throw new Error('already restored by the turn');
    });
    await expect(recovery.restore('s')).resolves.toMatchObject({ restored: true });
  });

  it('leaves a local Documents project without commits in its Documents view', async () => {
    const f = fixture();
    const project = { id: 'p', owner: 'o', repo: 'r', kind: 'local', cloneDir: 'empty' };
    mkdirSync(join(f.dir, 'clones', 'empty'), { recursive: true });
    const recovery = createCodeWorkspaceRecovery({
      ...f.deps,
      store: { ...f.deps.store, getProject: async () => project as unknown as ProjectRecord },
    });
    await expect(recovery.convert('s')).resolves.toBeNull();
    expect(f.session().worktree).toBe(f.view);
  });

  it('leaves a local project whose commits hold no code in its Documents view', async () => {
    const f = fixture();
    // Committed agent instructions alone: the Files panel still calls this Documents.
    const clone = join(f.dir, 'clones', 'notes');
    mkdirSync(clone, { recursive: true });
    git(['init', '-q', '-b', 'main', clone]);
    writeFileSync(join(clone, 'AGENTS.md'), '# Notes\n');
    git(['-C', clone, 'add', '-A']);
    git(['-C', clone, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
    const project = { id: 'p', owner: 'o', repo: 'r', kind: 'local', cloneDir: 'notes' };
    const recovery = createCodeWorkspaceRecovery({
      ...f.deps,
      store: { ...f.deps.store, getProject: async () => project as unknown as ProjectRecord },
    });
    await expect(recovery.convert('s')).resolves.toBeNull();
    expect(f.session().worktree).toBe(f.view);
  });

  it('logs a failed Git step without its command line or credentials', () => {
    const failure = Object.assign(
      new Error('Command failed: git fetch https://x:ghp_secret@host/r'),
      {
        code: 128,
        stderr: 'fatal: unable to access https://x:ghp_secret@host/r',
      },
    );
    const fields = describeCodeWorkspaceFailure(
      new CodeWorkspaceUnavailableError('restore failed', 'unrecoverable', { cause: failure }),
    );
    expect(JSON.stringify(fields)).not.toContain('ghp_secret');
    expect(fields).toMatchObject({ reason: 'unrecoverable', cause: { exitCode: 128 } });
  });

  it("converts at the conductor's own turn start even behind a queued turn", async () => {
    const f = fixture();
    f.busy();
    // The idle claim refuses while a turn is queued; the start of that very turn owns it.
    await createCodeWorkspaceRecovery(f.deps).beforeTurn('s', { starting: true });
    expect(f.session().worktree).toBe(f.target);
  });

  it('owes no conversion in Verity Control or without project clones', async () => {
    const f = fixture();
    const control = createCodeWorkspaceRecovery({
      ...f.deps,
      store: {
        ...f.deps.store,
        getProject: async () => ({ id: 'p', kind: 'control_plane' }) as unknown as ProjectRecord,
      },
    });
    await expect(control.beforeTurn('s')).resolves.toBeUndefined();
    const unconfigured = createCodeWorkspaceRecovery({ ...f.deps, cloneRoot: undefined });
    await expect(unconfigured.beforeTurn('s')).resolves.toBeUndefined();
    expect(f.session().worktree).toBe(f.view);
  });

  it('runs one conversion when a turn start and a Restore race', async () => {
    const f = fixture();
    const recovery = createCodeWorkspaceRecovery(f.deps);
    const [first, second] = await Promise.all([recovery.convert('s'), recovery.convert('s')]);
    expect(second).toBe(first);
    expect(first?.source).toBe('fresh');
  });

  it("never lets a Restore's busy refusal stand for a starting turn", async () => {
    const f = fixture();
    f.busy();
    const recovery = createCodeWorkspaceRecovery(f.deps);
    const restore = recovery.convert('s');
    await recovery.beforeTurn('s', { starting: true });
    await expect(restore).rejects.toMatchObject({ reason: 'busy' });
    expect(f.session().worktree).toBe(f.target);
  });

  it('checks the branch out again after its locked checkout was deleted outside Git', async () => {
    const f = fixture();
    git(['-C', f.clone, 'worktree', 'add', '-qb', 'code-s', f.target, 'main']);
    git([
      '-C',
      f.clone,
      'worktree',
      'lock',
      '--reason',
      'Verity session: managed by server',
      f.target,
    ]);
    rmSync(f.target, { recursive: true, force: true });
    // Git still lists the checkout and refuses its branch until that one entry goes.
    const result = await createCodeWorkspaceRecovery(f.deps).convert('s');
    expect(result?.source).toBe('branch');
    expect(head(f.target)).toBe('code-s');
  });

  it('also drops a stale entry whose gitdir Git recorded relative to it', async () => {
    const f = fixture();
    git(['-C', f.clone, 'worktree', 'add', '-qb', 'code-s', f.target, 'main']);
    git(['-C', f.clone, 'worktree', 'lock', f.target]);
    const admin = join(f.clone, '.git', 'worktrees', 'code-s');
    writeFileSync(join(admin, 'gitdir'), `${relative(admin, join(f.target, '.git'))}\n`);
    rmSync(f.target, { recursive: true, force: true });
    const result = await createCodeWorkspaceRecovery(f.deps).convert('s');
    expect(result?.source).toBe('branch');
    expect(head(f.target)).toBe('code-s');
  });
});
