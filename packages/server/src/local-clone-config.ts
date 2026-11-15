import { lstatSync, realpathSync, type Stats } from 'node:fs';

/**
 * The `.git/config` of a `local` project's clone: how to read it safely and what it may
 * keep before the provisioner freezes it read-only into the Sandbox (see
 * `localCloneConfigBind` and `ProvisionerImpl.sanitizeLocalCloneConfig` in provisioner.ts).
 */

/**
 * What `<clone>/.git/config` turns out to be on disk.
 *
 * - `absent` — nothing there, and specifically ENOENT. A half-prepared clone; skipped on
 *   both paths. Any other error reading it is `unsafe`, not `absent`: skipping past a
 *   file that cannot be read would provision the sandbox with an unexamined, writable
 *   config, which is the boundary this exists to hold.
 * - `file` — a regular file inside the clone's own `.git`, which is the only thing
 *   Verity ever puts there and the only shape it will read and freeze.
 * - `unsafe` — anything else, and specifically a symlink: the sandbox can replace this
 *   path, and both users of it are privileged. `git config --file` would REWRITE the
 *   link's target as the server's user, and the bind mount would publish that target
 *   into the container. Neither may be attempted on a guess about where it points.
 */
export type LocalConfigState = 'absent' | 'file' | 'unsafe';

/** Default {@link ProvisionerOptions.localConfigState}: a probe that follows no link. */
export function inspectLocalConfig(clonePath: string): LocalConfigState {
  const file = `${clonePath}/.git/config`;
  let stat: Stats;
  try {
    stat = lstatSync(file); // deliberately not statSync: the last component is not followed
  } catch (error) {
    // Only "there is nothing there" is absent. A permission error, an I/O error, a parent
    // that is not a directory — those are a file this cannot read, and an unreadable file
    // is not one to skip past: skipping means provisioning a sandbox with a writable,
    // unexamined config, which is the boundary this exists to hold.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unsafe';
  }
  // A symlink, a directory, a fifo — a regular file is the only thing that is this file.
  if (!stat.isFile()) return 'unsafe';
  // `lstat` only declines to follow the LAST component, so `.git` itself could be a link
  // to somewhere else entirely. Resolving the whole path settles where the file lives.
  try {
    return realpathSync(file) === `${realpathSync(clonePath)}/.git/config` ? 'file' : 'unsafe';
  } catch {
    return 'unsafe';
  }
}

/**
 * Everything a `local` clone's `.git/config` is allowed to keep — an ALLOWLIST, not a
 * denylist of the keys that name a program.
 *
 * A denylist has to enumerate every way a config value reaches an exec: hooks, the
 * fsmonitor, `filter.*`, `diff.*.textconv`, `merge.*.driver`, `credential.helper`,
 * `*.sshCommand`, an `ext::` remote URL, a submodule's `update = !cmd`, plus whatever
 * a later git adds. Listing what may STAY inverts that: a key nobody thought about is
 * dropped rather than kept, and the file after the pass is one Verity fully describes.
 *
 * These are the keys `git init` writes (the platform-dependent ones included) plus the
 * repository-format extensions, which describe how the object store is READ — dropping
 * `extensions.objectFormat` from a SHA-256 repository would make it unreadable.
 * `extensions.worktreeConfig` is deliberately absent: it is what makes the per-worktree
 * `config.worktree` file — which stays writable — take effect.
 *
 * A local project has no remote by design, so `remote.*` and `branch.*` go too. So does
 * an identity a session set on the repository: the sandbox's git identity comes from the
 * agent seed's global config, which this never touches.
 *
 * The VALUE is allowlisted with the key. A name alone would let a sandbox freeze
 * `core.bare = true` or `extensions.objectFormat = whatever` into a repository that
 * afterwards cannot be opened — the freeze makes that permanent, which is the same
 * damage from the other side. A value outside its set is dropped with the key, so git's
 * own default applies instead: for a value git would refuse anyway, that loses nothing.
 */
const CONFIG_BOOLEANS: ReadonlySet<string> = new Set([
  'true',
  'false',
  'yes',
  'no',
  'on',
  'off',
  '1',
  '0',
]);

const FROZEN_LOCAL_CONFIG_KEYS = new Map<string, ReadonlySet<string>>([
  ['core.repositoryformatversion', new Set(['0', '1'])],
  ['core.filemode', CONFIG_BOOLEANS],
  // A managed clone is a working checkout — sessions commit in worktrees of it and
  // Verity merges in it — so only the false half is a value this repository can have.
  // Frozen at `true` it would have no worktree at all.
  ['core.bare', new Set(['false', 'no', 'off', '0'])],
  ['core.logallrefupdates', CONFIG_BOOLEANS],
  ['core.symlinks', CONFIG_BOOLEANS],
  ['core.ignorecase', CONFIG_BOOLEANS],
  ['core.precomposeunicode', CONFIG_BOOLEANS],
  ['extensions.objectformat', new Set(['sha1', 'sha256'])],
  ['extensions.compatobjectformat', new Set(['sha1', 'sha256'])],
  ['extensions.refstorage', new Set(['files', 'reftable'])],
]);

/** One `key = value` line of a config file, as git listed it. `value` is absent for a
 *  key written without one, which git reads as a boolean true. */
export type ConfigEntry = { name: string; value?: string };

/**
 * The names in `entries` {@link FROZEN_LOCAL_CONFIG_KEYS} does not cover, plus the ones
 * it covers carrying a value it does not.
 *
 * git prints section and key lowercased but preserves a subsection's case, so the
 * comparison is case-insensitive while the returned name stays the one git matches on.
 * Names are returned once each: `--unset-all` drops every value a key has, so a key with
 * one bad value among several goes entirely.
 */
export function configKeysToDrop(entries: readonly ConfigEntry[]): string[] {
  const drop = entries.filter(({ name, value }) => {
    const allowed = FROZEN_LOCAL_CONFIG_KEYS.get(name.toLowerCase());
    return allowed === undefined || value === undefined || !allowed.has(value.trim().toLowerCase());
  });
  return [...new Set(drop.map(({ name }) => name))];
}
