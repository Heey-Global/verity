import type { EventStore, ProjectRecord, SessionMoveStore, SessionRecord } from '@verity/store';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  documentViewForSession,
  documentWorkspace,
  isDocumentWorkspace,
} from './document-workspace.js';
import { containerPathFor } from './project-backend.js';
import { hasCodeContent, legacySessionCodePath } from './project-code.js';
import { projectClonePath } from './provisioner.js';
import { describeCheckoutFailure } from './session-repositories.js';
import { addExistingBranchWorktree, type WorktreeProvisioner } from './worktree.js';

const execFileAsync = promisify(execFile);

/**
 * A code session whose working directory cannot be provided. Callers report it instead
 * of handing out the session's Documents view, which looks like a workspace but holds
 * no checkout and no branch.
 */
export class CodeWorkspaceUnavailableError extends Error {
  readonly code = 'code_workspace_unavailable';
  constructor(
    message: string,
    readonly reason: 'busy' | 'unrecoverable' = 'unrecoverable',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CodeWorkspaceUnavailableError';
  }
}

/**
 * Log fields for a failed recovery. A Git failure's own message is its full command
 * line, and its output can carry a remote URL with credentials after a fetch; only
 * the redacted, bounded detail of a checkout failure is logged.
 */
export function describeCodeWorkspaceFailure(error: unknown): Record<string, unknown> {
  if (!(error instanceof CodeWorkspaceUnavailableError))
    return { cause: describeCheckoutFailure(error) };
  return {
    message: error.message,
    reason: error.reason,
    ...(error.cause !== undefined ? { cause: describeCheckoutFailure(error.cause) } : {}),
  };
}

/** A symlinked or relocated clone root names the same directory by another path. */
const same = async (a: string, b: string): Promise<boolean> =>
  a === b || (await realpath(a).catch(() => a)) === (await realpath(b).catch(() => b));

/** Where the converted session's code came from, in the order they are tried. */
export type CodeWorkspaceSource = 'adopted' | 'journal' | 'branch' | 'origin' | 'fresh';

export interface CodeWorkspaceConversion {
  worktree: string;
  branch: string;
  source: CodeWorkspaceSource;
  /** Documents that could not be published and were copied into the new view. */
  transferred: string[];
  retainedWorktree: string;
}

/** Runs Git and returns its standard output. */
export type GitOutputRunner = (args: readonly string[]) => Promise<string>;

export interface CodeWorkspaceRecoveryDeps {
  store: Pick<EventStore, 'getSession' | 'getProject' | 'getSessionMove'> & {
    readonly sessionMoves: Pick<SessionMoveStore, 'prepareRelayout' | 'commitRelayout'>;
  };
  cloneRoot: string | undefined;
  dataRoot?: string | undefined;
  defaultBranch: (projectId: string) => Promise<string>;
  worktrees: (
    project: ProjectRecord,
    clonePath: string,
    opts: { baseBranch: string },
  ) => WorktreeProvisioner;
  /** Restores a worktree from its retirement journal; a no-op without one. */
  ensureWorkspace: (session: SessionRecord) => Promise<void>;
  /** Makes a local project's clone a Git repository before any worktree exists. */
  prepareLocalDocuments?: ((projectId: string) => Promise<void>) | undefined;
  /** Runs `fn` only while the session has no turn in flight or queued. */
  claimIdle: <T>(
    sessionId: string,
    fn: () => Promise<T>,
  ) => Promise<{ ran: true; value: T } | { ran: false }>;
  closeBackends: (sessionId: string) => Promise<void>;
  afterCommit?: ((sessionId: string, retainedWorktree: string) => Promise<void>) | undefined;
  git?: GitOutputRunner | undefined;
  /** Network Git uses the project's authenticated sandbox runner when configured. */
  remoteGit?: ((project: ProjectRecord, clone: string) => GitOutputRunner) | undefined;
}

/** Prefix of the conversion's move key; a retry resumes the same reservation. */
const OPERATION = 'code-workspace';

const hostGit: GitOutputRunner = async (args) =>
  (await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', ...args])).stdout;

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Converts a legacy Documents session — whose working directory is a Documents view
 * and whose code lives in a derived `code-<id>` sibling — into an ordinary code
 * session. Existing code is adopted unchanged; a missing checkout is restored from its
 * retirement journal or branch, and created fresh only when no trace of it remains.
 */
export function createCodeWorkspaceRecovery(deps: CodeWorkspaceRecoveryDeps) {
  const git = deps.git ?? hostGit;

  const hasRef = async (clone: string, ref: string): Promise<boolean> =>
    git(['-C', clone, 'rev-parse', '--verify', '--quiet', ref]).then(
      (out) => out.trim().length > 0,
      () => false,
    );

  async function hasRemoteBranch(
    project: ProjectRecord,
    clone: string,
    branch: string,
  ): Promise<boolean> {
    const cached = await hasRef(clone, `refs/remotes/origin/${branch}`);
    const remoteGit = deps.remoteGit?.(project, clone) ?? git;
    const remotes = await remoteGit(['-C', clone, 'remote']);
    if (!remotes.split(/\s+/u).includes('origin')) return cached;
    // A new clone may have no tracking ref for saved session work. An unreachable
    // origin proves nothing about that work and must never allow a fresh branch.
    const remote = await remoteGit([
      '-C',
      clone,
      'ls-remote',
      '--heads',
      'origin',
      `refs/heads/${branch}`,
    ]);
    if (!remote.trim()) return cached;
    await remoteGit([
      '-C',
      clone,
      'fetch',
      '--no-tags',
      'origin',
      `refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    return true;
  }

  async function materialize(
    project: ProjectRecord,
    session: SessionRecord,
    clone: string,
    target: string,
    branch: string,
  ): Promise<CodeWorkspaceSource> {
    if (await exists(target)) {
      const top = await git(['-C', target, 'rev-parse', '--show-toplevel']).then(
        (out) => out.trim(),
        () => '',
      );
      // A separate repository here would send commits and pushes elsewhere.
      const common = async (dir: string) =>
        git(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir']).then(
          (out) => realpath(out.trim()),
          () => '',
        );
      // Anything else at this path belongs to someone; it is never replaced.
      if (
        !top ||
        (await realpath(top)) !== (await realpath(target)) ||
        (await common(target)) !== (await common(clone))
      )
        throw new CodeWorkspaceUnavailableError(
          `${target} exists but is not this session's Git checkout`,
        );
      return 'adopted';
    }
    await deps.ensureWorkspace({ ...session, worktree: target });
    if (await exists(target)) return 'journal';
    await dropStaleRegistration(clone, target);
    const options = {
      repoDir: clone,
      worktreeRoot: dirname(target),
      git: async (args: readonly string[]) => void (await git(args)),
    };
    const [source, created]: [CodeWorkspaceSource, string] = (await hasRef(
      clone,
      `refs/heads/${branch}`,
    ))
      ? ['branch', await addExistingBranchWorktree(options, branch)]
      : (await hasRemoteBranch(project, clone, branch))
        ? ['origin', await addExistingBranchWorktree(options, branch, `origin/${branch}`)]
        : [
            'fresh',
            await deps
              .worktrees(project, clone, { baseBranch: await deps.defaultBranch(project.id) })
              .add(branch),
          ];
    // The session row is about to name `target`; a checkout anywhere else would strand it.
    if (created !== target) throw new Error(`Unexpected code workspace path ${created}`);
    return source;
  }

  /**
   * A checkout deleted outside Git leaves its registration, locked like every session
   * worktree, and Git then refuses to check its branch out again. Only that one entry
   * goes: the branch and its commits stay, and the directory is already gone.
   */
  async function dropStaleRegistration(clone: string, target: string): Promise<void> {
    const admin = join(clone, '.git', 'worktrees', basename(target));
    const gitdir = await readFile(join(admin, 'gitdir'), 'utf8').catch(() => null);
    // The entry must name this very checkout, never another one that shares its name.
    if (gitdir === null) return;
    // The checkout is gone, so only its parent can be compared by real path.
    const named = resolve(admin, gitdir.trim());
    if (
      basename(named) !== '.git' ||
      basename(dirname(named)) !== basename(target) ||
      !(await same(dirname(dirname(named)), dirname(target)))
    )
      return;
    if (await exists(target)) return;
    await rm(admin, { recursive: true, force: true });
  }

  /** Publish what the old view still holds; copy only what could not be published. */
  async function carryDocuments(
    projectId: string,
    legacyView: string,
    target: string,
    sessionId: string,
    operation: string,
  ): Promise<string[]> {
    const view = documentViewForSession({ sessionId, worktree: target });
    if (!deps.dataRoot || !view) return [];
    const source = documentWorkspace(deps.dataRoot, projectId, legacyView);
    // As before every turn: refresh first, so publication compares against current documents.
    await source.prepare();
    // Unpublishable edits stay pending and are copied below instead of being lost.
    await source.publish().catch(() => undefined);
    const destination = documentWorkspace(deps.dataRoot, projectId, view);
    await destination.prepare();
    if (!(await source.hasPendingChanges())) return [];
    return source.transferPending(destination, `Transferred edits/${operation}`);
  }

  /** One conversion per session at a time: a turn start and a Restore may race. */
  const running = new Map<string, Promise<CodeWorkspaceConversion | null>>();
  function convert(sessionId: string, claim = deps.claimIdle, starting = false) {
    const prior = running.get(sessionId);
    // A request joins a running conversion. A turn start waits for it instead: a
    // Restore's idle claim refuses the starting turn, and that refusal is not its own.
    if (prior && !starting) return prior;
    const next = (prior ?? Promise.resolve(null))
      .catch(() => null)
      .then(() => convertOnce(sessionId, claim))
      .finally(() => {
        if (running.get(sessionId) === next) running.delete(sessionId);
      });
    running.set(sessionId, next);
    return next;
  }

  async function convertOnce(
    sessionId: string,
    claimIdle: CodeWorkspaceRecoveryDeps['claimIdle'],
  ): Promise<CodeWorkspaceConversion | null> {
    let session = await deps.store.getSession(sessionId);
    if (!session) throw new CodeWorkspaceUnavailableError(`session ${sessionId} not found`);
    if (!isDocumentWorkspace(session.worktree)) return null;
    const projectId = session.projectId;
    // Without project clones, or in Verity Control, a Documents view is the whole workspace.
    if (projectId === null || !deps.cloneRoot) return null;
    const project = await deps.store.getProject(projectId);
    if (!project) throw new CodeWorkspaceUnavailableError(`project ${projectId} not found`);
    if (project.kind === 'control_plane') return null;
    await deps.prepareLocalDocuments?.(projectId);
    session = (await deps.store.getSession(sessionId)) ?? session;
    const clone = projectClonePath(deps.cloneRoot, project);
    // Git searches parent directories; only the clone's own repository counts.
    const own = await git(['-C', clone, 'rev-parse', '--show-toplevel']).then(
      async (out) => (await realpath(out.trim())) === (await realpath(clone)),
      () => false,
    );
    if (!own || !(await hasRef(clone, 'HEAD'))) {
      // A local project without a single commit is a Documents project: nothing to check out.
      if (project.kind === 'local') return null;
      throw new CodeWorkspaceUnavailableError(
        `project ${projectId}'s clone is not a Git repository`,
      );
    }
    const target = legacySessionCodePath(session.worktree, sessionId);
    // The Files panel's rule: a local project is a code project only once it holds code.
    if (
      project.kind === 'local' &&
      !(target && (await hasCodeContent(target))) &&
      !(await hasCodeContent(clone))
    )
      return null;
    if (!target || !(await same(dirname(target), join(clone, '.verity-sessions'))))
      throw new CodeWorkspaceUnavailableError(
        `${session.worktree} is outside project ${projectId}'s clone`,
      );
    const branch = `code-${sessionId}`;
    const legacy = session;
    // Keyed by the view it leaves: an abandoned reservation for another view never blocks.
    const operation = `${OPERATION}-${createHash('sha256').update(legacy.worktree).digest('hex').slice(0, 16)}`;
    const claim = await claimIdle(sessionId, async () => {
      const prior = await deps.store.getSessionMove(sessionId, operation);
      // Committed, yet the row names the view again: something outside Verity reverted it.
      if (prior?.result_json)
        throw new CodeWorkspaceUnavailableError(
          `the session was converted before, but its workspace is again ${legacy.worktree}`,
        );
      if (prior && (prior.source_worktree !== legacy.worktree || prior.target_worktree !== target))
        throw new CodeWorkspaceUnavailableError('the session changed since its conversion began');
      await deps.store.sessionMoves.prepareRelayout({
        sessionId,
        operationId: operation,
        projectId,
        sourceWorktree: legacy.worktree,
        targetWorktree: target,
        branch,
      });
      const source = await materialize(project, legacy, clone, target, branch);
      const transferred = await carryDocuments(
        projectId,
        legacy.worktree,
        target,
        sessionId,
        operation,
      );
      const current =
        (
          await git(['-C', target, 'symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')
        ).trim() || branch;
      const result: CodeWorkspaceConversion = {
        worktree: target,
        branch: current,
        source,
        transferred,
        retainedWorktree: legacy.worktree,
      };
      await deps.closeBackends(sessionId);
      const notice =
        `Verity converted this session to a code session. Your working directory is now the code workspace ` +
        `${containerPathFor(target, clone)} on branch ${current}; your Documents working copy is ` +
        `../../.verity-document-sessions/code-${sessionId}. Paths into .verity-document-sessions in earlier ` +
        `messages are historical; the previous Documents view is retained unchanged.` +
        (transferred.length
          ? ` Edits that could not be published were copied under Transferred edits/${operation}.`
          : '');
      await deps.store.sessionMoves.commitRelayout(
        sessionId,
        operation,
        notice,
        JSON.stringify(result),
      );
      return result;
    });
    if (!claim.ran)
      throw new CodeWorkspaceUnavailableError(
        'the session is busy; its code workspace is restored when the current turn ends',
        'busy',
      );
    // The conversion is durable by now; a stale cache or overview only refreshes later.
    await deps.afterCommit?.(sessionId, legacy.worktree).catch(() => undefined);
    return claim.value;
  }

  /** Convert a legacy session, or bring back an ordinary session's retired checkout. */
  async function restore(
    sessionId: string,
  ): Promise<{ restored: boolean } & Partial<CodeWorkspaceConversion>> {
    const converted = await convert(sessionId);
    if (converted) return { restored: true, ...converted };
    const session = await deps.store.getSession(sessionId);
    if (!session || (await exists(session.worktree))) return { restored: false };
    // The turn's own journal restore may win the race; the checkout being back is what counts.
    const failure = await deps.ensureWorkspace(session).then(
      () => undefined,
      (error: unknown) => error,
    );
    if (!(await exists(session.worktree))) {
      if (failure !== undefined)
        throw failure instanceof Error
          ? failure
          : new Error('workspace restore failed', { cause: failure });
      throw new CodeWorkspaceUnavailableError(
        `${session.worktree} is missing and has no recovery record`,
      );
    }
    return { restored: true, worktree: session.worktree, source: 'journal' };
  }

  return {
    convert,
    restore,
    /**
     * Before a turn: convert a legacy session, or fail visibly. `starting` is the
     * conductor's own turn start, which already owns the idle session; a request that
     * arrives during a turn leaves the conversion to that start.
     */
    async beforeTurn(sessionId: string, { starting = false } = {}): Promise<void> {
      try {
        await convert(
          sessionId,
          starting ? async (_, fn) => ({ ran: true, value: await fn() }) : deps.claimIdle,
          starting,
        );
        const session = await deps.store.getSession(sessionId);
        if (deps.cloneRoot && session?.projectId && !(await exists(session.worktree))) {
          const project = await deps.store.getProject(session.projectId);
          if (project && project.kind !== 'local' && project.kind !== 'control_plane')
            await restore(sessionId);
        }
      } catch (error) {
        if (!starting && error instanceof CodeWorkspaceUnavailableError && error.reason === 'busy')
          return;
        throw error instanceof CodeWorkspaceUnavailableError
          ? error
          : // Git output can carry credentials from a fetch; it stays in the server log.
            new CodeWorkspaceUnavailableError(
              'the code workspace could not be restored; the server log names the cause',
              'unrecoverable',
              { cause: error },
            );
      }
    },
  };
}

export type CodeWorkspaceRecovery = ReturnType<typeof createCodeWorkspaceRecovery>;
