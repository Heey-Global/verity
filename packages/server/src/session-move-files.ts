import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  unlink,
  writeFile,
  chmod,
  symlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const MAX_BYTES = 64 * 1024 * 1024;
export class SessionMoveError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
export async function moveGit(cwd: string, ...args: string[]): Promise<Buffer> {
  return (await exec('git', ['-C', cwd, ...args], { encoding: 'buffer', maxBuffer: MAX_BYTES }))
    .stdout;
}
async function hashBlob(root: string, value: FileValue): Promise<string> {
  if (!value) throw new Error('Cannot hash an absent file');
  return await new Promise<string>((resolve, reject) => {
    const child = execFile('git', ['-C', root, 'hash-object', '-w', '--stdin'], (error, stdout) => {
      if (error) reject(new Error(error.message, { cause: error }));
      else resolve(stdout.trim());
    });
    child.stdin!.on('error', reject);
    child.stdin!.end(Buffer.from(value.data, 'base64'));
  });
}
function text(bytes: Buffer): string {
  const value = bytes.toString('utf8');
  if (!Buffer.from(value).equals(bytes))
    throw new SessionMoveError('unsupported_path', 'Non-UTF-8 filenames cannot be moved.');
  return value;
}
const paths = (bytes: Buffer): string[] => text(bytes).split('\0').filter(Boolean);
type FileValue = { mode: string; data: string } | null;
type GitEntry = { mode: string; oid: string };
export interface MoveSnapshot {
  head: string;
  branch: string;
  files: { path: string; base: FileValue; index: FileValue; working: FileValue }[];
  skipped: string[];
  fingerprint: string;
}
const same = (a: FileValue, b: FileValue): boolean => a?.mode === b?.mode && a?.data === b?.data;
function safePath(path: string): void {
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')
  ) {
    throw new SessionMoveError('unsupported_path', `Unsafe transfer path: ${path}`);
  }
}
async function stat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
async function checkAncestors(root: string, path: string): Promise<void> {
  safePath(path);
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const parent = await stat(join(root, ...parts.slice(0, i)));
    if (parent && (!parent.isDirectory() || parent.isSymbolicLink())) {
      throw new SessionMoveError('file_conflict', `Unsafe ancestor of ${path}`);
    }
  }
}
async function workingValue(root: string, path: string): Promise<FileValue> {
  await checkAncestors(root, path);
  const file = join(root, path);
  const info = await stat(file);
  if (!info) return null;
  if (info.isSymbolicLink())
    return {
      mode: '120000',
      data: (await readlink(file, { encoding: 'buffer' })).toString('base64'),
    };
  if (!info.isFile() || info.size > MAX_BYTES)
    throw new SessionMoveError('unsupported_file', `Unsupported file type or size: ${path}`);
  return {
    mode: info.mode & 0o111 ? '100755' : '100644',
    data: (await readFile(file)).toString('base64'),
  };
}
async function gitValue(root: string, entry: GitEntry | undefined): Promise<FileValue> {
  if (!entry) return null;
  if (!['100644', '100755', '120000'].includes(entry.mode))
    throw new SessionMoveError(
      'unsupported_file',
      'Submodules and special index entries cannot be moved.',
    );
  return {
    mode: entry.mode,
    data: (await moveGit(root, 'cat-file', 'blob', entry.oid)).toString('base64'),
  };
}
async function tree(root: string): Promise<Map<string, GitEntry>> {
  return new Map(
    paths(await moveGit(root, 'ls-tree', '-rz', 'HEAD')).map((line) => {
      const tab = line.indexOf('\t');
      const [mode, , oid] = line.slice(0, tab).split(' ');
      return [line.slice(tab + 1), { mode: mode!, oid: oid! }];
    }),
  );
}
export async function captureMoveSnapshot(root: string): Promise<MoveSnapshot> {
  const head = text(await moveGit(root, 'rev-parse', 'HEAD')).trim();
  const branch = text(await moveGit(root, 'symbolic-ref', '--short', 'HEAD')).trim();
  const flags = paths(await moveGit(root, 'ls-files', '-v', '-z'));
  if (flags.some((entry) => entry[0] === 'S' || entry[0] !== entry[0]?.toUpperCase()))
    throw new SessionMoveError(
      'unsupported_index',
      'Disable skip-worktree and assume-unchanged flags before moving.',
    );
  const index = new Map<string, GitEntry>();
  for (const line of paths(await moveGit(root, 'ls-files', '--stage', '-z'))) {
    const tab = line.indexOf('\t');
    const [mode, oid, stage] = line.slice(0, tab).split(' ');
    if (stage !== '0' || /^0+$/.test(oid!))
      throw new SessionMoveError(
        'unsupported_index',
        'Resolve index conflicts or intent-to-add entries before moving.',
      );
    index.set(line.slice(tab + 1), { mode: mode!, oid: oid! });
  }
  const visibleIndex = paths(
    await moveGit(root, 'diff', '--cached', '--name-only', '--ita-visible-in-index', '-z', 'HEAD'),
  );
  const realIndex = new Set(
    paths(
      await moveGit(
        root,
        'diff',
        '--cached',
        '--name-only',
        '--ita-invisible-in-index',
        '-z',
        'HEAD',
      ),
    ),
  );
  if (visibleIndex.some((path) => !realIndex.has(path)))
    throw new SessionMoveError(
      'unsupported_index',
      'Stage or unstage intent-to-add entries before moving.',
    );
  const affected = new Set([
    ...paths(await moveGit(root, 'diff', '--name-only', '--no-renames', '-z')),
    ...paths(await moveGit(root, 'diff', '--cached', '--name-only', '--no-renames', '-z', 'HEAD')),
    ...paths(await moveGit(root, 'ls-files', '--others', '--exclude-standard', '-z')),
  ]);
  const base = await tree(root);
  const skipped = paths(
    await moveGit(
      root,
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
      '-z',
    ),
  );
  const files: MoveSnapshot['files'] = [];
  let bytes = 0;
  for (const path of [...affected].sort()) {
    safePath(path);
    if (path.split('/').includes('node_modules')) {
      skipped.push(path);
      continue;
    }
    const file = {
      path,
      base: await gitValue(root, base.get(path)),
      index: await gitValue(root, index.get(path)),
      working: await workingValue(root, path),
    };
    bytes += [file.base, file.index, file.working].reduce((n, v) => n + (v?.data.length ?? 0), 0);
    if (bytes > MAX_BYTES)
      throw new SessionMoveError(
        'transfer_too_large',
        'Uncommitted work exceeds the 64 MiB transfer limit.',
      );
    files.push(file);
  }
  const captured = { head, branch, files, skipped: skipped.sort() };
  return {
    ...captured,
    fingerprint: createHash('sha256').update(JSON.stringify(captured)).digest('hex'),
  };
}
async function writeValue(root: string, path: string, value: FileValue): Promise<void> {
  await checkAncestors(root, path);
  const target = join(root, path);
  const existing = await stat(target);
  if (existing) {
    if (!existing.isFile() && !existing.isSymbolicLink())
      throw new SessionMoveError('file_conflict', `Path is not a file: ${path}`);
    await unlink(target);
  }
  if (!value) return;
  await mkdir(dirname(target), { recursive: true });
  if (value.mode === '120000') await symlink(Buffer.from(value.data, 'base64'), target);
  else {
    await writeFile(target, Buffer.from(value.data, 'base64'), {
      flag: 'wx',
      mode: value.mode === '100755' ? 0o755 : 0o644,
    });
    await chmod(target, value.mode === '100755' ? 0o755 : 0o644);
  }
}
/** Only call against a newly allocated, unexposed target worktree. */
export async function transferMoveSnapshot(
  snapshot: MoveSnapshot,
  target: string,
): Promise<{ transferred: string[]; alreadyPresent: string[] }> {
  const targetTree = await tree(target);
  // Git applies checkout/clean filters when deciding whether tracked files changed.
  const dirtyPaths = new Set(
    paths(await moveGit(target, 'diff', '--name-only', '--no-renames', '-z', 'HEAD')),
  );
  const conflicts: string[] = [];
  const alreadyPresent: string[] = [];
  for (const file of snapshot.files) {
    const base = await gitValue(target, targetTree.get(file.path));
    const working = await workingValue(target, file.path);
    if (
      dirtyPaths.has(file.path) ||
      (!base && working !== null) ||
      (base && !same(base, file.base) && !same(base, file.index) && !same(base, file.working))
    )
      conflicts.push(file.path);
    if (same(base, file.working) && (same(base, file.index) || same(file.index, file.base)))
      alreadyPresent.push(file.path);
  }
  if (conflicts.length)
    throw new SessionMoveError(
      'file_conflict',
      `Conflicting target paths: ${conflicts.join(', ')}`,
    );
  for (const file of snapshot.files) {
    if (alreadyPresent.includes(file.path)) continue;
    // Hash the captured index bytes without checkout filters; git add would stage
    // the working bytes instead and silently erase partial staging.
    if (file.index) {
      const oid = await hashBlob(target, file.index);
      await moveGit(
        target,
        'update-index',
        '--add',
        '--cacheinfo',
        file.index.mode,
        oid,
        file.path,
      );
    } else await moveGit(target, 'update-index', '--force-remove', '--', file.path);
    await writeValue(target, file.path, file.working);
  }
  const index = new Map(
    paths(await moveGit(target, 'ls-files', '--stage', '-z')).map((line) => {
      const tab = line.indexOf('\t');
      const [mode, oid] = line.slice(0, tab).split(' ');
      return [line.slice(tab + 1), { mode: mode!, oid: oid! }];
    }),
  );
  for (const file of snapshot.files) {
    if (alreadyPresent.includes(file.path)) continue;
    if (
      !same(file.index, await gitValue(target, index.get(file.path))) ||
      !same(file.working, await workingValue(target, file.path))
    )
      throw new SessionMoveError(
        'verification_failed',
        `Transfer verification failed: ${file.path}`,
      );
  }
  return {
    transferred: snapshot.files
      .map(({ path }) => path)
      .filter((path) => !alreadyPresent.includes(path)),
    alreadyPresent,
  };
}
