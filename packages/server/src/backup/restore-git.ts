import { constants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { captureTree } from './filesystem.js';
import { openBackupPath, runBackupGit, sanitizedGitConfig } from './git.js';
import { captureMetadataSchema, type CaptureMetadata } from './capture-metadata.js';
import { validateBackupPath } from './format.js';

async function readControl(root: string, path: string): Promise<string> {
  const file = await openBackupPath(root, path, false);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 1024 * 1024)
      throw new Error('Invalid restored Git control file');
    const bytes = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== info.size) throw new Error('Restored Git file changed');
    return bytes.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
}
async function replaceControl(root: string, path: string, contents: string): Promise<void> {
  const file = await openBackupPath(root, path, false);
  try {
    if (!(await file.stat()).isFile()) throw new Error('Invalid restored Git pointer type');
  } finally {
    await file.close();
  }
  const parent = await openBackupPath(root, dirname(path), true);
  try {
    const target = await open(
      `/proc/self/fd/${parent.fd}/${path.slice(path.lastIndexOf('/') + 1)}`,
      constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      await target.writeFile(contents);
    } finally {
      await target.close();
    }
  } finally {
    await parent.close();
  }
}
function movedTarget(
  metadata: CaptureMetadata,
  base: string,
  target: string,
  projectId: string,
): string {
  if (!target || target.length > 4096 || /[\0\r\n]/.test(target))
    throw new Error('Invalid restored Git pointer');
  const absolute = resolve(metadata.sourceRoot, base, target);
  const local = relative(metadata.sourceRoot, absolute);
  validateBackupPath(local);
  const project = metadata.projects.find((candidate) => candidate.id === projectId);
  if (!project || !project.paths.some((path) => local === path || local.startsWith(path + '/')))
    throw new Error('Restored Git pointer escapes its project');
  return local;
}
async function assertDirectoryParent(root: string, path: string): Promise<void> {
  const parent = await openBackupPath(root, dirname(path), true);
  await parent.close();
}

/** Private staging only. Validate EVERY pointer before the first Git command; user config returns last. */
export async function prepareRestoredGit(
  root: string,
  metadata: CaptureMetadata,
  liveRoot: string = root,
  signal?: AbortSignal,
): Promise<string[]> {
  signal?.throwIfAborted();
  metadata = captureMetadataSchema.parse(metadata);
  if (!isAbsolute(liveRoot) || resolve(liveRoot) !== liveRoot)
    throw new Error('Invalid live restore root');
  const pointerUpdates = new Map<string, string>();
  const warnings: string[] = [];
  const privateRoot = join(root, 'git-restore');
  await mkdir(privateRoot, { mode: 0o700 });
  for (const git of metadata.git) {
    signal?.throwIfAborted();
    validateBackupPath(git.path);
    if (!git.path.endsWith('/.git')) throw new Error('Invalid restored Git directory path');
    const source = `git/${git.repoKey}/git`;
    // A link found at capture was deliberately omitted rather than stored as a Git directory.
    if (git.findings.includes('symlink:.git omitted')) {
      warnings.push(`${git.projectId}: Code incomplete`);
      continue;
    }
    const pinned = await openBackupPath(root, source, true);
    await pinned.close();
    for await (const entry of captureTree(join(root, source), {
      prefix: source,
      excludeRegenerable: false,
      ...(signal ? { signal } : {}),
      onExcluded: () => {
        throw new Error('Special file inside restored Git');
      },
    })) {
      if (entry.kind === 'symlink') throw new Error('Link inside restored Git directory');
      if (entry.kind === 'directory') continue;
      const local = entry.path.slice(source.length + 1);
      if (
        /(^|\/)(gitdir|commondir)$/.test(local) &&
        !git.pointers.some((pointer) => pointer.path === local)
      )
        throw new Error('Restored Git pointer is missing from inventory');
      if (/(^|\/)config$/.test(entry.path)) {
        const sanitized = sanitizedGitConfig(await readControl(root, entry.path));
        if (sanitized === undefined) throw new Error('Unsupported restored Git configuration');
        await replaceControl(root, entry.path, sanitized);
      }
      if (/(^|\/)(hooks\/|config\.worktree$|objects\/info\/alternates$)/.test(entry.path))
        throw new Error('User configuration was not isolated from restored Git');
    }
    await assertDirectoryParent(root, git.path);
    await rename(join(root, source), join(root, git.path));
  }
  // Physical common directories exist now, so linked worktree and submodule targets can be checked.
  const worktrees = new Map<string, string[]>();
  for (const git of metadata.git) {
    signal?.throwIfAborted();
    if (git.findings.includes('symlink:.git omitted')) continue;
    for (const pointer of git.pointers) {
      validateBackupPath(pointer.path);
      if (!/(^|\/)(gitdir|commondir)$/.test(pointer.path))
        throw new Error('Invalid Git pointer inventory');
      const path = `${git.path}/${pointer.path}`;
      const local = movedTarget(metadata, dirname(path), pointer.target, git.projectId);
      const target = await openBackupPath(root, local, pointer.path.endsWith('commondir'));
      await target.close();
      await replaceControl(root, path, join(root, local) + '\n');
      pointerUpdates.set(path, local);
      if (pointer.path.endsWith('gitdir')) {
        if (!local.endsWith('/.git'))
          throw new Error('Worktree registration must point to a .git file');
        const paths = worktrees.get(git.repoKey) ?? [];
        paths.push(join(root, dirname(local)));
        worktrees.set(git.repoKey, paths);
      }
    }
  }
  for (const scope of ['workspaces', 'sessions']) {
    for await (const entry of captureTree(join(root, scope), {
      prefix: scope,
      excludeRegenerable: false,
      ...(signal ? { signal } : {}),
      onExcluded: () => undefined,
      onGit: (_path, kind) => {
        if (kind === 'symlink') throw new Error('Restored .git is a link');
      },
    })) {
      if (entry.kind === 'directory' || entry.kind === 'symlink' || !entry.path.endsWith('/.git'))
        continue;
      const text = await readControl(root, entry.path);
      const match = /^gitdir: ([^\0\r\n]+)\r?\n?$/.exec(text);
      if (!match) throw new Error('Invalid restored .git file');
      const project = metadata.projects.find((candidate) =>
        candidate.paths.some((path) => entry.path.startsWith(path + '/')),
      );
      if (!project) throw new Error('Restored worktree has no project');
      const local = movedTarget(metadata, dirname(entry.path), match[1]!, project.id);
      const target = await openBackupPath(root, local, true);
      await target.close();
      await replaceControl(root, entry.path, `gitdir: ${join(root, local)}\n`);
      pointerUpdates.set(entry.path, local);
    }
  }
  // Recheck all rewritten targets immediately before Git. All staged data remains private.
  for (const git of metadata.git) {
    signal?.throwIfAborted();
    if (git.findings.includes('symlink:.git omitted')) continue;
    for (const pointer of git.pointers) {
      const local = movedTarget(
        metadata,
        dirname(`${git.path}/${pointer.path}`),
        pointer.target,
        git.projectId,
      );
      const file = await openBackupPath(root, local, pointer.path.endsWith('commondir'));
      await file.close();
    }
  }
  try {
    for (const git of metadata.git) {
      signal?.throwIfAborted();
      if (git.status !== 'validated') {
        warnings.push(`${git.projectId}: Code incomplete (${git.status})`);
        continue;
      }
      const directory = join(root, git.path);
      const work = join(root, dirname(git.path));
      if (
        !(await runBackupGit(directory, privateRoot, 'fsck', work, [], signal)) ||
        !(await runBackupGit(
          directory,
          privateRoot,
          'repair',
          work,
          worktrees.get(git.repoKey) ?? [],
          signal,
        ))
      )
        warnings.push(`${git.projectId}: Code incomplete`);
    }
  } finally {
    for (const [path, local] of pointerUpdates) {
      const contents = path.endsWith('/.git')
        ? `gitdir: ${join(liveRoot, local)}\n`
        : join(liveRoot, local) + '\n';
      await replaceControl(root, path, contents);
    }
    try {
      await restoreUserFiles(root, metadata);
    } finally {
      await rm(privateRoot, { recursive: true, force: true });
    }
  }
  signal?.throwIfAborted();
  return warnings;
}

async function restoreUserFiles(
  root: string,
  metadata: CaptureMetadata,
  signal?: AbortSignal,
): Promise<void> {
  // No more Git commands after reinstating user-written files, even when validation failed.
  for (const git of metadata.git) {
    signal?.throwIfAborted();
    if (git.findings.includes('symlink:.git omitted')) continue;
    const source = join(root, 'git', git.repoKey, 'user-files');
    for await (const entry of captureTree(source, {
      prefix: 'user-files',
      excludeRegenerable: false,
      ...(signal ? { signal } : {}),
      onExcluded: () => {
        throw new Error('Invalid Git user file');
      },
    })) {
      const local = entry.path.slice('user-files/'.length);
      if (!local || entry.path === 'user-files' || entry.kind === 'directory') continue;
      if (entry.kind === 'symlink') throw new Error('Link in restored Git user files');
      // The writer's fixed relocation set is the only content allowed back under .git.
      if (
        !local.split('/').includes('hooks') &&
        !/(^|\/)config(?:\.worktree)?$/.test(local) &&
        !/(^|\/)objects\/info\/alternates$/.test(local)
      )
        throw new Error('Unexpected Git user file');
      const target = join(root, git.path, local);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await assertDirectoryParent(root, `${git.path}/${local}`);
      await rm(target, { force: true });
      await rename(join(source, local), target);
    }
  }
}
