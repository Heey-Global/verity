import { dependencyInputIdentity } from './dependency-inputs.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import type { ProjectRecord, SessionRecord } from '@verity/store';
import type { GitOutput } from './branches.js';
import { linkWorkspacePackages, WORKTREE_SIDECAR } from './worktree.js';

const WEEK = 7 * 24 * 60 * 60_000;
const inputs =
  /(^|\/)(package.json|package-lock.json|npm-shrinkwrap.json|yarn.lock|pnpm-lock.yaml|pnpm-workspace.yaml|\.npmrc)$/;
export interface SessionStorageReport {
  observedAt: string;
  dependenciesRemoved: string[];
  worktreesRetired: string[];
  blockers: Array<{ path: string; reason: string }>;
  comparedDependencyBytes: number;
  worktreeSampledBytes: number | null;
  dependencySampledBytes: number | null;
  usageComplete: boolean;
  dryRun: boolean;
}
interface Retirement {
  version: 1;
  sessionId: string | null;
  path: string;
  sha: string;
  branch: string | null;
  sidecar: string | null;
  locked?: boolean;
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if ((await lstat(dirname(path))).isSymbolicLink())
    throw new Error('Storage journal is a symlink');
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
  const dir = await open(dirname(path), 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
async function optionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function digest(path: string, signal: AbortSignal): Promise<string> {
  const file = await open(path, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(128 * 1024);
    for (;;) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) return hash.digest('hex');
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await file.close();
  }
}
/** A file is disposable only if another compatible installation still holds the same bytes. */
export async function compareDependencyTrees(
  privatePath: string,
  sharedPath: string,
  signal: AbortSignal,
  roots = { local: privatePath, shared: sharedPath },
): Promise<number> {
  signal.throwIfAborted();
  const [local, shared] = await Promise.all([lstat(privatePath), lstat(sharedPath)]);
  if (local.isSymbolicLink()) {
    if (!shared.isSymbolicLink() || (await readlink(privatePath)) !== (await readlink(sharedPath)))
      throw new Error('Dependency link differs');
    const target = await readlink(privatePath);
    const localRelative = relative(roots.local, resolve(dirname(privatePath), target));
    const sharedRelative = relative(roots.shared, resolve(dirname(sharedPath), target));
    const internal =
      !isAbsolute(target) &&
      !isAbsolute(localRelative) &&
      !isAbsolute(sharedRelative) &&
      localRelative !== '..' &&
      !localRelative.startsWith('../') &&
      sharedRelative !== '..' &&
      !sharedRelative.startsWith('../');
    if (!internal && (await realpath(privatePath)) !== (await realpath(sharedPath)))
      throw new Error('Dependency link resolves to different source trees');
    return 0;
  }
  if (local.isDirectory() && shared.isDirectory()) {
    let bytes = 0;
    const entries = (await readdir(privatePath))
      .filter((entry) => entry !== '.package-lock.json' || !privatePath.endsWith('/node_modules'))
      .sort();
    const sharedEntries = (await readdir(sharedPath))
      .filter((entry) => entry !== '.package-lock.json' || !sharedPath.endsWith('/node_modules'))
      .sort();
    if (JSON.stringify(entries) !== JSON.stringify(sharedEntries))
      throw new Error('Dependency directory entries differ');
    for (const entry of entries) {
      if (entry === '.package-lock.json' && privatePath.endsWith('/node_modules')) continue; // npm-generated installation receipt, never source.
      bytes += await compareDependencyTrees(
        join(privatePath, entry),
        join(sharedPath, entry),
        signal,
        roots,
      );
    }
    return bytes;
  }
  if (
    !local.isFile() ||
    !shared.isFile() ||
    local.size !== shared.size ||
    (local.mode & 0o777) !== (shared.mode & 0o777) ||
    (await digest(privatePath, signal)) !== (await digest(sharedPath, signal))
  ) {
    throw new Error('Dependency has local edits or no shared copy');
  }
  return local.blocks * 512;
}

export class SessionStorage {
  private claim?: <T>(
    id: string,
    run: () => Promise<T>,
  ) => Promise<{ ran: true; value: T } | { ran: false }>;
  private blocked: (projectId: string) => boolean = () => true;
  private flight: Promise<void> | undefined;
  lastReport?: SessionStorageReport;
  constructor(
    private readonly deps: {
      listProjects: () => Promise<ProjectRecord[]>;
      listSessions: () => Promise<SessionRecord[]>;
      activity: (id: string) => Promise<number | null>;
      root: (project: ProjectRecord) => string;
      withGit: <T>(project: ProjectRecord, operation: (git: GitOutput) => Promise<T>) => Promise<T>;
      mutate: (
        projectId: string,
        sessionId: string | undefined,
        operation: () => Promise<void>,
      ) => Promise<void>;
      pr: (project: ProjectRecord, branch: string) => Promise<{ phase: string } | null>;
      wake?: (project: ProjectRecord, sessionId: string) => Promise<void>;
      now?: () => number;
      dryRun?: boolean;
      gitRoot?: string;
    },
  ) {}
  bind(claim: NonNullable<SessionStorage['claim']>, blocked: (projectId: string) => boolean): void {
    this.claim = claim;
    this.blocked = blocked;
  }
  private async safeRoot(project: ProjectRecord, path: string): Promise<string> {
    const root = resolve(this.deps.root(project));
    const sessions = join(root, '.verity-sessions');
    if (
      dirname(path) !== sessions ||
      path !== resolve(path) ||
      (await realpath(root)) !== root ||
      (await realpath(sessions)) !== sessions ||
      (await realpath(join(root, '.git'))) !== join(root, '.git')
    )
      throw new Error('Unknown or symlinked worktree root');
    if ((await exists(path)) && (await lstat(path)).isSymbolicLink())
      throw new Error('Worktree is a symlink');
    return root;
  }
  private hostGitPath(root: string, recorded: string): string {
    if (!this.deps.gitRoot) return recorded;
    const subpath = relative(this.deps.gitRoot, recorded);
    if (isAbsolute(subpath) || subpath === '..' || subpath.startsWith('../'))
      throw new Error('Git worktree path escapes its sandbox');
    return resolve(root, subpath);
  }
  private async registrations(
    root: string,
    git: GitOutput,
  ): Promise<Map<string, string | undefined>> {
    const entries = new Map<string, string | undefined>();
    let current: string | undefined;
    for (const field of (await git(['-C', root, 'worktree', 'list', '--porcelain', '-z'])).split(
      '\0',
    )) {
      if (field.startsWith('worktree ')) {
        current = this.hostGitPath(root, field.slice(9));
        entries.set(current, undefined);
      } else if (current && (field === 'locked' || field.startsWith('locked ')))
        entries.set(current, field.slice(7));
    }
    return entries;
  }
  private manifest(root: string, path: string): string {
    return join(
      root,
      '.git',
      'verity-storage',
      `retired-${createHash('sha256').update(path).digest('hex')}.json`,
    );
  }
  private async retirementSource(root: string, path: string): Promise<string | null> {
    const journal = this.manifest(root, path);
    if (!(await exists(journal))) return null;
    if ((await realpath(dirname(journal))) !== dirname(journal) || !(await lstat(journal)).isFile())
      throw new Error('Unsafe worktree retirement journal');
    return optionalFile(journal);
  }
  async canRestore(session: SessionRecord): Promise<boolean> {
    try {
      const project = (await this.deps.listProjects()).find((p) => p.id === session.projectId);
      if (!project || project.kind === 'control_plane') return false;
      const root = await this.safeRoot(project, session.worktree);
      const entry = JSON.parse(
        (await this.retirementSource(root, session.worktree)) ?? 'null',
      ) as Retirement | null;
      return (
        entry !== null &&
        entry.version === 1 &&
        entry.sessionId === session.sessionId &&
        entry.path === session.worktree &&
        /^[a-f0-9]{40,64}$/.test(entry.sha) &&
        (entry.branch === null || typeof entry.branch === 'string') &&
        (entry.sidecar === null || typeof entry.sidecar === 'string') &&
        (entry.locked === undefined || typeof entry.locked === 'boolean')
      );
    } catch {
      return false;
    }
  }
  async ensureWorkspace(session: SessionRecord): Promise<void> {
    const project = (await this.deps.listProjects()).find((p) => p.id === session.projectId);
    if (!project || project.kind === 'control_plane') return;
    if (dirname(session.worktree) !== join(resolve(this.deps.root(project)), '.verity-sessions'))
      return;
    // Ordinary sessions need no recovery and may use unmanaged repository layouts.
    // Require the stricter retirement boundary only when a journal actually exists.
    try {
      if (!(await exists(this.manifest(resolve(this.deps.root(project)), session.worktree))))
        return;
    } catch (error) {
      // Linked checkouts use a .git file and cannot contain our retirement journal.
      if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') return;
      throw error;
    }
    const root = await this.safeRoot(project, session.worktree);
    const path = this.manifest(root, session.worktree);
    const source = await this.retirementSource(root, session.worktree);
    if (!source) return;
    const entry = JSON.parse(source) as Retirement;
    if (
      entry.version !== 1 ||
      entry.sessionId !== session.sessionId ||
      entry.path !== session.worktree ||
      !/^[a-f0-9]{40,64}$/.test(entry.sha) ||
      (entry.branch !== null && typeof entry.branch !== 'string') ||
      (entry.sidecar !== null && typeof entry.sidecar !== 'string') ||
      (entry.locked !== undefined && typeof entry.locked !== 'boolean')
    ) {
      throw new Error('Worktree retirement journal does not match this session');
    }
    await this.deps.wake?.(project, session.sessionId);
    await this.deps.withGit(project, async (git) => {
      if (!(await exists(session.worktree))) {
        let ref = entry.sha;
        if (entry.branch) {
          const current = await git([
            '-C',
            root,
            'rev-parse',
            '--verify',
            `refs/heads/${entry.branch}`,
          ]).catch(() => '');
          if (current.trim() === entry.sha) ref = entry.branch;
        }
        await git([
          '-C',
          root,
          'worktree',
          'add',
          ...(ref === entry.sha ? ['--detach'] : []),
          '--',
          relative(root, session.worktree),
          ref,
        ]);
      }
      if ((await git(['-C', session.worktree, 'rev-parse', 'HEAD'])).trim() !== entry.sha) {
        throw new Error('Restored worktree differs from its retirement journal');
      }
      if (entry.sidecar !== null && !(await exists(join(session.worktree, WORKTREE_SIDECAR)))) {
        const file = await open(join(session.worktree, WORKTREE_SIDECAR), 'wx', 0o600);
        try {
          await file.writeFile(entry.sidecar);
          await file.sync();
        } finally {
          await file.close();
        }
      }
      if (entry.locked) {
        const registrations = await this.registrations(root, git);
        const reason = registrations.get(session.worktree);
        if (reason !== undefined && reason !== 'Verity session: managed by server')
          throw new Error('Restored worktree has an unknown lock');
        if (reason === undefined)
          await git([
            '-C',
            root,
            'worktree',
            'lock',
            '--reason',
            'Verity session: managed by server',
            '--',
            relative(root, session.worktree),
          ]);
      }
      linkWorkspacePackages(root, session.worktree);
      // Keep the durable recovery record until the directory is complete; source refs stay pinned.
      await rm(path);
    });
  }
  runOnce(): Promise<void> {
    if (this.flight) return this.flight;
    this.flight = this.sweep().finally(() => {
      this.flight = undefined;
    });
    return this.flight;
  }
  private async sweep(): Promise<void> {
    if (!this.claim) return;
    const now = this.deps.now?.() ?? Date.now();
    const signal = AbortSignal.timeout(60_000);
    const report: SessionStorageReport = {
      observedAt: new Date(now).toISOString(),
      dependenciesRemoved: [],
      worktreesRetired: [],
      blockers: [],
      comparedDependencyBytes: 0,
      worktreeSampledBytes: null,
      dependencySampledBytes: null,
      usageComplete: false,
      dryRun: this.deps.dryRun ?? false,
    };
    this.lastReport = report;
    const projects = await this.deps.listProjects();
    const sessions = await this.deps.listSessions();
    for (const project of projects) {
      if (project.kind === 'control_plane' || this.blocked(project.id)) continue;
      const owned = sessions.filter((s) => s.projectId === project.id);
      for (const session of owned) {
        if (signal.aborted) return;
        const activity = await this.deps.activity(session.sessionId);
        if (activity === null || now - activity < WEEK) continue;
        await this.claim(session.sessionId, async () => {
          try {
            await this.deps.mutate(project.id, session.sessionId, async () => {
              if (this.blocked(project.id)) return;
              const fresh = (await this.deps.listSessions()).find(
                (s) => s.sessionId === session.sessionId,
              );
              const latest = await this.deps.activity(session.sessionId);
              if (
                !fresh ||
                fresh.worktree !== session.worktree ||
                latest === null ||
                now - latest < WEEK
              )
                return;
              await this.deps.withGit(project, (git) =>
                this.reclaim(project, session.worktree, session.sessionId, git, report, signal),
              );
            });
          } catch (error) {
            report.blockers.push({
              path: session.worktree,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        });
      }
      // Orphans are registered Git worktrees, never directory-name guesses.
      if (!signal.aborted)
        try {
          await this.deps.mutate(project.id, undefined, async () => {
            if (this.blocked(project.id)) return;
            await this.deps.withGit(project, async (git) => {
              const root = resolve(this.deps.root(project));
              const journal = join(root, '.git', 'verity-storage', 'orphans.json');
              const old = JSON.parse((await optionalFile(journal)) ?? '{}') as Record<
                string,
                number
              >;
              const current: Record<string, number> = {};
              const live = new Set((await this.deps.listSessions()).map((s) => s.worktree));
              for (const path of (await this.registrations(root, git)).keys()) {
                if (dirname(path) !== join(root, '.verity-sessions') || live.has(path)) continue;
                const since = old[path];
                current[path] =
                  typeof since === 'number' && Number.isFinite(since) && since > 0 ? since : now;
                if (now - current[path] < WEEK) continue;
                try {
                  await this.reclaim(project, path, null, git, report, signal);
                } catch (error) {
                  report.blockers.push({
                    path,
                    reason: error instanceof Error ? error.message : String(error),
                  });
                }
              }
              if (!this.deps.dryRun) await atomicJson(journal, current);
            });
          });
        } catch (error) {
          report.blockers.push({
            path: this.deps.root(project),
            reason: error instanceof Error ? error.message : String(error),
          });
        }
    }
    await this.sampleUsage(
      sessions
        .filter(
          (s) =>
            projects.some((p) => p.kind !== 'control_plane' && p.id === s.projectId) &&
            dirname(s.worktree) ===
              join(
                resolve(this.deps.root(projects.find((p) => p.id === s.projectId)!)),
                '.verity-sessions',
              ),
        )
        .map((s) => s.worktree),
      report,
    );
  }
  private async sampleUsage(paths: string[], report: SessionStorageReport): Promise<void> {
    const deadline = AbortSignal.timeout(3000);
    let total = 0,
      dependencies = 0;
    const walk = async (path: string, inDependencies: boolean): Promise<void> => {
      deadline.throwIfAborted();
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) return;
      total += stat.blocks * 512;
      if (inDependencies) dependencies += stat.blocks * 512;
      if (stat.isDirectory()) {
        const directory = await opendir(path);
        for await (const entry of directory)
          await walk(join(path, entry.name), inDependencies || entry.name === 'node_modules');
      }
    };
    try {
      for (const path of paths)
        if (await exists(path)) {
          if ((await realpath(dirname(path))) !== dirname(path))
            throw new Error('Symlinked sample root');
          await walk(path, false);
        }
      report.usageComplete = true;
    } catch {
      /* A bounded partial sample is not total filesystem use. */
    }
    report.worktreeSampledBytes = total;
    report.dependencySampledBytes = dependencies;
  }
  private async reclaim(
    project: ProjectRecord,
    path: string,
    sessionId: string | null,
    git: GitOutput,
    report: SessionStorageReport,
    signal: AbortSignal,
  ): Promise<void> {
    const root = await this.safeRoot(project, path);
    const firstRemoval = report.dependenciesRemoved.length;
    try {
      await this.reclaimContents(project, path, sessionId, git, report, signal);
    } finally {
      // Restore wiring only for installations this pass verified and removed.
      // A rejected private graph can contain intentionally customized workspace links.
      if (
        !this.deps.dryRun &&
        report.dependenciesRemoved.slice(firstRemoval).includes(join(path, 'node_modules')) &&
        (await exists(path))
      )
        linkWorkspacePackages(root, path);
    }
  }
  private async reclaimContents(
    project: ProjectRecord,
    path: string,
    sessionId: string | null,
    git: GitOutput,
    report: SessionStorageReport,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const root = await this.safeRoot(project, path);
    if (!(await exists(path))) return;
    const files = (await git(['-C', path, 'ls-files', '-z'])).split('\0').filter(Boolean);
    const dependencyInputs = files.filter((f) => inputs.test(f));
    const baseFiles = (await git(['-C', root, 'ls-files', '-z']))
      .split('\0')
      .filter((f) => inputs.test(f));
    const compatible =
      dependencyInputs.length === baseFiles.length &&
      dependencyInputs.includes('package.json') &&
      dependencyInputs.some((f) => /lock/.test(f)) &&
      dependencyInputs.every((f) => baseFiles.includes(f));
    if (!compatible) throw new Error('Dependency manifests differ or are unknown');
    for (const f of dependencyInputs) {
      const localInput = join(path, f),
        sharedInput = join(root, f);
      for (const input of [localInput, sharedInput]) {
        if ((await realpath(input)) !== input || !(await lstat(input)).isFile())
          throw new Error('Dependency input is a symlink or unknown file');
      }
      let matches: boolean;
      try {
        matches =
          dependencyInputIdentity(f, await readFile(localInput, 'utf8')) ===
          dependencyInputIdentity(f, await readFile(sharedInput, 'utf8'));
      } catch {
        throw new Error('Dependency inputs are invalid or unavailable');
      }
      if (!matches) throw new Error('Dependency inputs differ');
    }
    const unknownManifests = (
      await git(['-C', path, 'ls-files', '--others', '--exclude-standard', '-z'])
    )
      .split('\0')
      .some((f) => inputs.test(f));
    if (unknownManifests) throw new Error('Untracked dependency inputs');
    // Only node_modules trees with byte-identical shared copies qualify. Unknown build output stays protected.
    // Nested installations are outside Node's ancestor lookup from a worktree.
    // Retain them until equivalent private resolution can be restored safely.
    const modulePaths = ['node_modules'];
    let dependencyMismatch = false;
    for (const modules of modulePaths) {
      let ancestor = path;
      for (const part of modules.split('/').slice(0, -1)) {
        ancestor = join(ancestor, part);
        if ((await lstat(ancestor)).isSymbolicLink())
          throw new Error('Dependency ancestor is a symlink');
      }
      const local = join(path, modules);
      if (!(await exists(local))) continue;
      const stat = await lstat(local);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      if (files.some((f) => f === modules || f.startsWith(`${modules}/`)))
        throw new Error('Tracked dependency files');
      const removeVerified = async (candidate: string, shared: string): Promise<boolean> => {
        try {
          const before = await lstat(candidate);
          const bytes = await compareDependencyTrees(candidate, shared, signal);
          signal.throwIfAborted();
          const latest = await lstat(candidate);
          if (latest.ino !== before.ino || latest.dev !== before.dev)
            throw new Error('Dependency root changed');
          report.comparedDependencyBytes += bytes;
          if (!this.deps.dryRun) await rm(candidate, { recursive: true });
          report.dependenciesRemoved.push(candidate);
          return true;
        } catch (error) {
          signal.throwIfAborted();
          report.blockers.push({
            path: candidate,
            reason: error instanceof Error ? error.message : String(error),
          });
          return false;
        }
      };
      // Keep the entire private graph when any package differs: shared dependents
      // would otherwise resolve shared versions instead of retained local patches.
      if (!(await removeVerified(local, join(root, modules)))) dependencyMismatch = true;
    }
    if (dependencyMismatch) throw new Error('Private dependency differences remain');
    const sha = (await git(['-C', path, 'rev-parse', 'HEAD'])).trim();
    const branch =
      (
        await git(['-C', path, 'symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')
      ).trim() || null;
    if (
      sessionId &&
      (!branch ||
        !['merged', 'closed'].includes((await this.deps.pr(project, branch))?.phase ?? ''))
    ) {
      if (!this.deps.dryRun) linkWorkspacePackages(root, path);
      return;
    }
    // Git status and non-force removal can overlook edits hidden by index flags.
    const indexEntries = (await git(['-C', path, 'ls-files', '-v', '-z'])).split('\0');
    if (indexEntries.some((entry) => /^[a-zS] /.test(entry)))
      throw new Error('Index flags may hide local changes');
    // Refresh remote evidence before trusting reachability; a failed fetch retains the worktree.
    await git(['-C', root, 'fetch', '--prune', 'origin']);
    const saved = (
      await git([
        '-C',
        path,
        'for-each-ref',
        `--contains=${sha}`,
        '--format=%(refname)',
        'refs/remotes/origin',
      ])
    ).trim();
    if (!saved) throw new Error('HEAD is not reachable from a verified remote branch');
    if (
      (await git(['-C', path, 'status', '--porcelain=v1', '--untracked-files=all'])).trim() ||
      (await git(['-C', path, 'stash', 'list'])).trim()
    )
      throw new Error('Local changes or stashes remain');
    const ignored = (
      await git(['-C', path, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z'])
    )
      .split('\0')
      .filter(Boolean);
    if (ignored.some((f) => f !== WORKTREE_SIDECAR))
      throw new Error('Unknown ignored files remain');
    const registrations = await this.registrations(root, git);
    if (!registrations.has(path)) throw new Error('Worktree registration is unknown');
    const reason = registrations.get(path);
    if (reason !== undefined && reason !== 'Verity session: managed by server')
      throw new Error('Worktree has an unknown lock');
    const previousSource = await this.retirementSource(root, path);
    const previous = previousSource ? (JSON.parse(previousSource) as Retirement) : null;
    if (
      previousSource !== null &&
      (!previous ||
        previous.version !== 1 ||
        previous.sessionId !== sessionId ||
        previous.path !== path ||
        previous.sha !== sha)
    )
      throw new Error('Existing retirement journal differs');
    const locked = reason !== undefined || previous?.locked === true;
    if (this.deps.dryRun) {
      report.worktreesRetired.push(path);
      return;
    }
    const pin = `refs/verity/retired/${createHash('sha256').update(path).digest('hex')}`;
    await git(['-C', root, 'update-ref', pin, sha]);
    const sidecarPath = join(path, WORKTREE_SIDECAR);
    if ((await exists(sidecarPath)) && !(await lstat(sidecarPath)).isFile())
      throw new Error('Worktree sidecar is not a regular file');
    const sidecar = await optionalFile(sidecarPath);
    await atomicJson(this.manifest(root, path), {
      version: 1,
      sessionId,
      path,
      sha,
      branch,
      sidecar,
      locked,
    } satisfies Retirement);
    // Non-force removal is the final Git backstop. The durable journal precedes it.
    if (reason !== undefined)
      await git(['-C', root, 'worktree', 'unlock', '--', relative(root, path)]);
    try {
      await git(['-C', root, 'worktree', 'remove', '--', relative(root, path)]);
      if (await exists(path)) throw new Error('Git left the worktree directory behind');
    } catch (error) {
      if (locked && (await exists(path)))
        await git([
          '-C',
          root,
          'worktree',
          'lock',
          '--reason',
          'Verity session: managed by server',
          '--',
          relative(root, path),
        ]).catch(() => undefined);
      throw error;
    }
    report.worktreesRetired.push(path);
  }
}
