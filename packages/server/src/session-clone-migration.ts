import { execFile, spawn } from 'node:child_process';
import {
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { assertIndependentSessionClone } from './session-clone.js';

const exec = promisify(execFile);

export interface SessionCloneMigrationOptions {
  checkoutPath: string;
  /** Trusted project clone from server metadata, never a checkout-controlled pointer. */
  projectRepoPath: string;
  backupRoot: string;
  /** Optional private destination; the original checkout then remains untouched. */
  destinationPath?: string;
  /** The server must stop the agent and development processes before calling. */
  stopped: boolean;
}

function assertNoMetadataSymlinks(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink())
      throw new Error('Git metadata contains a symlink; migration requires manual recovery');
    if (entry.isDirectory()) assertNoMetadataSymlinks(join(directory, entry.name));
  }
}

function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Explicit offline migration. The complete backup survives both success and failure. */
export async function migrateLegacySessionClone(
  opts: SessionCloneMigrationOptions,
): Promise<{ backupPath: string | undefined }> {
  if (!opts.stopped)
    throw new Error('Stop the session and its development processes before migration');
  const checkout = resolve(opts.checkoutPath);
  if (realpathSync(checkout) !== checkout || !lstatSync(checkout).isDirectory())
    throw new Error('Migration requires a real checkout directory');
  let gitFile = join(checkout, '.git');
  let legacyStorage: { admin: string; common: string } | undefined;
  if (lstatSync(gitFile).isFile()) {
    const trustedCommonPath = join(resolve(opts.projectRepoPath), '.git');
    const common = realpathSync(trustedCommonPath);
    if (common !== trustedCommonPath || !lstatSync(common).isDirectory())
      throw new Error('Trusted project Git storage is unavailable');
    const link = readFileSync(gitFile, 'utf8');
    if (!link.startsWith('gitdir:')) throw new Error('Invalid worktree Git link');
    const admin = realpathSync(resolve(checkout, link.slice('gitdir:'.length).trim()));
    if (resolve(admin, '..') !== join(common, 'worktrees'))
      throw new Error('Worktree Git storage does not belong to the recorded project');
    if (
      realpathSync(resolve(admin, readFileSync(join(admin, 'commondir'), 'utf8').trim())) !==
        common ||
      resolve(admin, readFileSync(join(admin, 'gitdir'), 'utf8').trim()) !== gitFile
    )
      throw new Error('Worktree Git registration does not belong to this session');
    legacyStorage = { admin, common };
  } else {
    await assertIndependentSessionClone(checkout);
  }
  // Initialized submodules retain administrative links outside the private checkout.
  // Refuse before moving any recovery artifacts rather than severing those links.
  const listing = spawn(
    'git',
    ['-c', 'core.fsmonitor=false', '-C', checkout, 'ls-files', '--stage', '-z'],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const completed = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    listing.once('error', (error) => resolve({ code: null, error }));
    listing.once('close', (code) => resolve({ code }));
  });
  listing.stdout.setEncoding('utf8');
  let pending = '';
  try {
    for await (const chunk of listing.stdout) {
      pending += String(chunk);
      let boundary: number;
      while ((boundary = pending.indexOf('\0')) !== -1) {
        const entry = pending.slice(0, boundary);
        pending = pending.slice(boundary + 1);
        if (!entry.startsWith('160000 ')) continue;
        const submodule = entry.slice(entry.indexOf('\t') + 1);
        if (existsSync(join(checkout, submodule, '.git')))
          throw new Error('Initialized submodules require manual recovery before migration');
      }
    }
    const result = await completed;
    if (result.code !== 0) throw new Error('Cannot inspect session index', { cause: result.error });
  } finally {
    listing.kill();
    await completed;
  }
  if (
    opts.destinationPath &&
    resolve(opts.destinationPath) !== checkout &&
    existsSync(opts.destinationPath)
  ) {
    const destination = resolve(opts.destinationPath);
    const backupRoot = resolve(opts.backupRoot);
    if (!existsSync(backupRoot) || realpathSync(backupRoot) !== backupRoot)
      throw new Error('Migration destination already exists without a trusted backup');
    const owned = readdirSync(backupRoot, { withFileTypes: true }).some((entry) => {
      if (!entry.isDirectory() || !entry.name.startsWith('session-migration-')) return false;
      const manifest = join(backupRoot, entry.name, 'manifest.json');
      if (!existsSync(manifest) || lstatSync(manifest).isSymbolicLink()) return false;
      try {
        const record = JSON.parse(readFileSync(manifest, 'utf8')) as {
          checkout?: unknown;
          destination?: unknown;
        };
        return record.checkout === checkout && record.destination === destination;
      } catch {
        return false;
      }
    });
    if (!owned || realpathSync(destination) !== destination)
      throw new Error('Migration destination already exists without a matching migration');
    // An interrupted relocation may have left a prepared or partial clone. Keep it
    // intact, then rebuild from the original so later uncommitted work is retained.
    const recovery = mkdtempSync(join(resolve(destination, '..'), '.migration-recovery-'));
    renameSync(destination, join(recovery, 'checkout'));
  }
  if (lstatSync(gitFile).isDirectory()) {
    await assertIndependentSessionClone(checkout);
    if (!opts.destinationPath || resolve(opts.destinationPath) === checkout)
      return { backupPath: undefined };
    const destination = resolve(opts.destinationPath);
    const backupRoot = resolve(opts.backupRoot);
    if (contains(checkout, destination) || contains(checkout, backupRoot))
      throw new Error('Migration destination and backup must be outside the original checkout');
    if (existsSync(destination)) throw new Error('Migration destination already exists');
    mkdirSync(backupRoot, { recursive: true });
    if (realpathSync(backupRoot) !== backupRoot)
      throw new Error('Backup root must not contain symlinks');
    const backup = mkdtempSync(join(backupRoot, 'session-migration-'));
    writeFileSync(join(backup, 'manifest.json'), `${JSON.stringify({ checkout, destination })}\n`);
    cpSync(checkout, join(backup, 'checkout'), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
    mkdirSync(resolve(destination, '..'), { recursive: true });
    if (realpathSync(resolve(destination, '..')) !== resolve(destination, '..'))
      throw new Error('Migration destination parent must not contain symlinks');
    cpSync(join(backup, 'checkout'), destination, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
    await assertIndependentSessionClone(destination);
    return { backupPath: backup };
  }
  if (!lstatSync(gitFile).isFile())
    throw new Error('Migration requires a regular worktree Git link');
  if (!legacyStorage) throw new Error('Trusted worktree Git storage is unavailable');
  const { admin, common } = legacyStorage;
  assertNoMetadataSymlinks(common);
  assertNoMetadataSymlinks(admin);
  for (const marker of ['objects/info/alternates', 'objects/info/http-alternates']) {
    if (existsSync(join(common, marker)))
      throw new Error('Shared object alternates require manual recovery before migration');
  }
  const backupRoot = resolve(opts.backupRoot);
  if (contains(checkout, backupRoot) || contains(common, backupRoot))
    throw new Error('Backup must be outside the checkout and Git metadata');
  mkdirSync(backupRoot, { recursive: true });
  if (realpathSync(backupRoot) !== backupRoot)
    throw new Error('Backup root must not contain symlinks');
  const backup = mkdtempSync(join(backupRoot, 'session-migration-'));
  const copy = (from: string, to: string): void => {
    cpSync(from, to, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
  };
  // Nothing in the checkout changes until all recoverable files and Git state are backed up.
  copy(checkout, join(backup, 'checkout'));
  copy(common, join(backup, 'common-git'));
  copy(admin, join(backup, 'worktree-git'));
  writeFileSync(
    join(backup, 'manifest.json'),
    `${JSON.stringify({ checkout, admin, common, destination: opts.destinationPath ? resolve(opts.destinationPath) : checkout })}\n`,
  );
  const stage = join(backup, 'independent');
  await exec('git', ['clone', '--no-local', '--no-checkout', '--', common, stage]);
  const privateGit = join(stage, '.git');
  // Transport clones omit unreachable objects, including staged-only blobs and rebase commits.
  // Copy the snapshot's complete object store and original refs with independent inodes.
  for (const entry of ['objects', 'refs', 'packed-refs', 'logs', 'config']) {
    const source = join(backup, 'common-git', entry);
    if (existsSync(source)) copy(source, join(privateGit, entry));
  }
  // A linked worktree's administrative files carry its index and in-flight operations.
  // gitdir/commondir are precisely the links that must not survive isolation.
  for (const entry of readdirSync(join(backup, 'worktree-git'))) {
    if (entry === 'gitdir' || entry === 'commondir' || entry === 'locked') continue;
    copy(join(backup, 'worktree-git', entry), join(privateGit, entry));
  }
  // Worktree-specific settings override the common config, but storage and include
  // paths cannot follow the checkout into a private container.
  const worktreeConfig = join(privateGit, 'config.worktree');
  if (existsSync(worktreeConfig)) {
    const { stdout } = await exec('git', [
      'config',
      '--no-includes',
      '--file',
      worktreeConfig,
      '--null',
      '--list',
    ]);
    for (const entry of stdout.split('\0').filter(Boolean)) {
      const separator = entry.indexOf('\n');
      const key = separator < 0 ? entry : entry.slice(0, separator);
      const value = separator < 0 ? 'true' : entry.slice(separator + 1);
      await exec('git', [
        'config',
        '--file',
        join(privateGit, 'config'),
        '--replace-all',
        key,
        value,
      ]);
    }
    rmSync(worktreeConfig);
  }
  const configFile = join(privateGit, 'config');
  const { stdout: configEntries } = await exec('git', [
    'config',
    '--no-includes',
    '--file',
    configFile,
    '--null',
    '--list',
  ]);
  const keys = new Set(
    configEntries
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.split('\n')[0]!),
  );
  for (const key of keys) {
    if (/^(include\.path|includeif\..*\.path)$/i.test(key))
      throw new Error('Git config includes require manual recovery before migration');
    if (/^(core\.(worktree|hookspath|bare)|extensions\.worktreeconfig)$/i.test(key))
      await exec('git', ['config', '--file', configFile, '--unset-all', key]);
  }
  await exec('git', ['config', '--file', configFile, 'core.bare', 'false']);
  await assertIndependentSessionClone(stage);
  // Rename on the checkout's filesystem; backups may live on another volume.
  const destination = opts.destinationPath ? resolve(opts.destinationPath) : checkout;
  if (destination !== checkout) {
    if (
      contains(checkout, destination) ||
      contains(common, destination) ||
      contains(backup, destination)
    ) {
      throw new Error(
        'Migration destination must be outside the original checkout, Git storage and backup',
      );
    }
    if (existsSync(destination)) throw new Error('Migration destination already exists');
    mkdirSync(resolve(destination, '..'), { recursive: true });
    if (realpathSync(resolve(destination, '..')) !== resolve(destination, '..'))
      throw new Error('Migration destination parent must not contain symlinks');
    copy(join(backup, 'checkout'), destination);
    gitFile = join(destination, '.git');
  }
  const replacement = join(destination, '.verity-migration-git');
  if (existsSync(replacement)) throw new Error('A previous migration staging directory exists');
  copy(privateGit, replacement);
  const savedLink = join(destination, '.verity-migration-git-link');
  if (existsSync(savedLink)) {
    rmSync(replacement, { recursive: true });
    throw new Error('A previous migration link exists');
  }
  renameSync(gitFile, savedLink);
  try {
    renameSync(replacement, gitFile);
    await assertIndependentSessionClone(destination);
  } catch (error) {
    rmSync(gitFile, { recursive: true, force: true });
    renameSync(savedLink, gitFile);
    rmSync(replacement, { recursive: true, force: true });
    throw new Error('Migration failed; the original Git link was restored', { cause: error });
  }
  rmSync(savedLink);
  return { backupPath: backup };
}
