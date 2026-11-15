import type { EventStore, ProjectRecord, SessionMoveStore, SessionRecord } from '@verity/store';
import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  documentViewForSession,
  documentWorkspace,
  isDocumentWorkspace,
} from './document-workspace.js';
import { containerPathFor } from './project-backend.js';
import { legacySessionCodePath } from './project-code.js';
import { projectClonePath } from './provisioner.js';
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
}

/** One conversion per session: the key makes every retry resume the same reservation. */
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
      // Anything else at this path belongs to someone; it is never replaced.
      if (!top || (await realpath(top)) !== (await realpath(target)))
        throw new CodeWorkspaceUnavailableError(
          `${target} exists but is not this session's Git checkout`,
        );
      return 'adopted';
    }
    await deps.ensureWorkspace({ ...session, worktree: target });
    if (await exists(target)) return 'journal';
    const options = {
      repoDir: clone,
      worktreeRoot: dirname(target),
      git: async (args: readonly string[]) => void (await git(args)),
    };
    if (await hasRef(clone, `refs/heads/${branch}`)) {
      await addExistingBranchWorktree(options, branch);
      return 'branch';
    }
    if (await hasRef(clone, `refs/remotes/origin/${branch}`)) {
      await addExistingBranchWorktree(options, branch, `origin/${branch}`);
      return 'origin';
    }
    const created = await deps
      .worktrees(project, clone, { baseBranch: await deps.defaultBranch(project.id) })
      .add(branch);
    if (created !== target) throw new Error(`Unexpected code workspace path ${created}`);
    return 'fresh';
  }

  /** Publish what the old view still holds; copy only what could not be published. */
  async function carryDocuments(
    projectId: string,
    legacyView: string,
    target: string,
    sessionId: string,
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
    return source.transferPending(destination, `Transferred edits/${OPERATION}`);
  }

  async function convert(sessionId: string): Promise<CodeWorkspaceConversion | null> {
    let session = await deps.store.getSession(sessionId);
    if (!session) throw new CodeWorkspaceUnavailableError(`session ${sessionId} not found`);
    if (!isDocumentWorkspace(session.worktree)) return null;
    const projectId = session.projectId;
    if (projectId === null || !deps.cloneRoot)
      throw new CodeWorkspaceUnavailableError('code workspaces are not configured here');
    await deps.prepareLocalDocuments?.(projectId);
    session = (await deps.store.getSession(sessionId)) ?? session;
    const project = await deps.store.getProject(projectId);
    if (!project || project.kind === 'control_plane')
      throw new CodeWorkspaceUnavailableError(`project ${projectId} has no code workspace`);
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
    if (!target || dirname(target) !== join(clone, '.verity-sessions'))
      throw new CodeWorkspaceUnavailableError(
        `${session.worktree} is outside project ${projectId}'s clone`,
      );
    const branch = `code-${sessionId}`;
    const legacy = session;
    const claim = await deps.claimIdle(sessionId, async () => {
      const prior = await deps.store.getSessionMove(sessionId, OPERATION);
      if (prior?.result_json) return JSON.parse(prior.result_json) as CodeWorkspaceConversion;
      if (prior && (prior.source_worktree !== legacy.worktree || prior.target_worktree !== target))
        throw new CodeWorkspaceUnavailableError('the session changed since its conversion began');
      await deps.store.sessionMoves.prepareRelayout({
        sessionId,
        operationId: OPERATION,
        projectId,
        sourceWorktree: legacy.worktree,
        targetWorktree: target,
        branch,
      });
      const source = await materialize(project, legacy, clone, target, branch);
      const transferred = await carryDocuments(projectId, legacy.worktree, target, sessionId);
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
          ? ` Edits that could not be published were copied under Transferred edits/${OPERATION}.`
          : '');
      await deps.store.sessionMoves.commitRelayout(
        sessionId,
        OPERATION,
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
    await deps.afterCommit?.(sessionId, legacy.worktree);
    return claim.value;
  }

  /** Convert a legacy session, or bring back an ordinary session's retired checkout. */
  async function restore(sessionId: string): Promise<CodeWorkspaceConversion | null> {
    const converted = await convert(sessionId);
    if (converted) return converted;
    const session = await deps.store.getSession(sessionId);
    if (!session || (await exists(session.worktree))) return null;
    await deps.ensureWorkspace(session);
    if (!(await exists(session.worktree)))
      throw new CodeWorkspaceUnavailableError(
        `${session.worktree} is missing and has no recovery record`,
      );
    return null;
  }

  return {
    convert,
    restore,
    /**
     * Before a turn: convert a legacy session, or fail visibly. A session that is
     * already running a turn keeps it and converts before the next one.
     */
    async beforeTurn(sessionId: string): Promise<void> {
      try {
        await convert(sessionId);
      } catch (error) {
        if (error instanceof CodeWorkspaceUnavailableError && error.reason === 'busy') return;
        throw error instanceof CodeWorkspaceUnavailableError
          ? error
          : new CodeWorkspaceUnavailableError(
              `the code workspace could not be restored: ${(error as Error).message}`,
              'unrecoverable',
              { cause: error },
            );
      }
    },
  };
}

export type CodeWorkspaceRecovery = ReturnType<typeof createCodeWorkspaceRecovery>;
