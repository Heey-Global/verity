import { workspaceMatcher } from './worktree.js';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export type WorkspaceDependencyLinks = ReadonlyMap<string, { local: string; shared: string }>;

async function lockPackages(root: string): Promise<Record<string, unknown>> {
  let path = join(root, 'npm-shrinkwrap.json');
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    path = join(root, 'package-lock.json');
    try {
      await lstat(path);
    } catch (missing) {
      if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw missing;
    }
  }
  if ((await realpath(path)) !== path || !(await lstat(path)).isFile())
    throw new Error('Workspace dependency lock is symlinked or unavailable');
  const value = JSON.parse(await readFile(path, 'utf8')) as { packages?: unknown } | null;
  return value?.packages && typeof value.packages === 'object' && !Array.isArray(value.packages)
    ? (value.packages as Record<string, unknown>)
    : {};
}

async function packageName(root: string): Promise<string | undefined> {
  const path = join(root, 'package.json');
  if ((await realpath(path)) !== path || !(await lstat(path)).isFile()) return;
  const value = JSON.parse(await readFile(path, 'utf8')) as { name?: unknown } | null;
  const name = value?.name;
  return typeof name === 'string' &&
    /^(?:@[a-zA-Z0-9._~-]+\/)?[a-zA-Z0-9._~-]+$/u.test(name) &&
    !['.', '..'].includes(name)
    ? name
    : undefined;
}

/** Only declared workspace wiring may differ between otherwise identical trees.
 * Source targets must remain canonical in each checkout; arbitrary external
 * links and custom package redirects never acquire this exception. */
export async function workspaceDependencyLinks(
  worktree: string,
  sharedRoot: string,
  repositoryRoot: string,
): Promise<WorkspaceDependencyLinks> {
  const links = new Map<string, { local: string; shared: string }>();
  const roots = [worktree, sharedRoot, repositoryRoot];
  // These are the exact layouts and manifest names restored by
  // linkWorkspacePackages; matching npm file: links alone are not sufficient.
  for (const root of roots) {
    const manifest = join(root, 'package.json');
    try {
      if ((await realpath(manifest)) !== manifest || !(await lstat(manifest)).isFile())
        return links;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return links;
      throw error;
    }
  }
  const declarations = roots.map(workspaceMatcher);
  if (declarations.some((matches) => matches === undefined)) return links;
  const local = await lockPackages(worktree);
  const shared = await lockPackages(sharedRoot);
  for (const [path, entry] of Object.entries(local)) {
    if (!path.startsWith('node_modules/') || !entry || typeof entry !== 'object') continue;
    const value = entry as { link?: unknown; resolved?: unknown };
    const counterpart = shared[path] as { link?: unknown; resolved?: unknown } | undefined;
    if (
      value.link !== true ||
      counterpart?.link !== true ||
      value.resolved !== counterpart.resolved ||
      typeof value.resolved !== 'string'
    )
      continue;
    // npm file links outside this checkout are not workspace source wiring.
    if (
      [path, value.resolved].some(
        (name) =>
          isAbsolute(name) ||
          name.split(/[\\/]/u).some((part) => part === '..' || part === '.' || part === ''),
      )
    )
      continue;
    if (
      !/^(?:packages|apps)\/[^/\\]+$/u.test(value.resolved) ||
      declarations.some((matches) => !matches?.(value.resolved as string))
    )
      continue;
    const names = await Promise.all(
      roots.map((root) => packageName(join(root, value.resolved as string))),
    );
    if (!names[0] || names.some((name) => name !== names[0]) || path !== `node_modules/${names[0]}`)
      continue;
    const localTarget = resolve(worktree, value.resolved);
    const sharedTarget = resolve(sharedRoot, value.resolved);
    if (
      (await realpath(localTarget)) !== localTarget ||
      (await realpath(sharedTarget)) !== sharedTarget
    )
      continue;
    links.set(path.slice('node_modules/'.length), { local: localTarget, shared: sharedTarget });
  }
  return links;
}
