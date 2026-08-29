#!/usr/bin/env node
// Apply backported upstream fixes to the mobile app's native dependencies, in the
// installed node_modules tree, before the sources are copied into the generated
// Xcode/Gradle project.
//
// The app is a CNG (prebuild) app: `ios/` is generated on the EAS builder from
// node_modules, so a native dependency can only be corrected by editing what
// prebuild reads. Run from the repo root — `npm run -w @verity/mobile-app
// patch:native`, and automatically from `eas-build-post-install`, which EAS runs
// after `npm ci` and before prebuild/pod install. A local `npm ci` restores the
// unpatched sources, so a local native build needs `patch:native` again.
//
// Each patch is written to retire itself: it is skipped once the dependency
// reaches the release that carries the fix, so a version bump removes the patch's
// effect without anyone remembering it exists. It is *not* written to be lenient
// otherwise — if the dependency is still on an unfixed version but its source no
// longer matches, the script fails rather than shipping a binary that silently
// kept the bug.
//
// Usage: node scripts/patch-mobile-native-deps.mjs

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MOBILE_WORKSPACE = 'apps/mobile';

/**
 * @typedef {{
 *   package: string,
 *   file: string,
 *   fixedFrom: string,
 *   reference: string,
 *   why: string,
 *   requires: string[],
 *   before: string,
 *   after: string,
 * }} NativePatch
 */

/** @type {NativePatch[]} */
export const NATIVE_PATCHES = [
  {
    package: 'react-native-reanimated',
    file: 'apple/reanimated/apple/REANodesManager.mm',
    fixedFrom: '4.6.0',
    reference: 'software-mansion/react-native-reanimated#10229 (fixes #10135)',
    // `-[REANodesManager performOperations]` calls the `_performOperations` block
    // that `createReanimatedModuleProxy` installs on the JS queue. Installation
    // happens *after* `ReanimatedModuleProxy::init` has already exposed
    // `_maybeFlushUIUpdatesQueue` to the UI runtime, so a display-link frame that
    // lands in that window reaches the method with the ivar still nil and
    // dereferences the block's invoke pointer at 0x10 — a launch-time SIGSEGV on
    // the main thread (seen in TestFlight 1.10.0 (32), iPadOS 26.6.1).
    //
    // Skipping the flush is harmless: with no proxy there is nothing to flush yet,
    // and pending updates are picked up on the next drain.
    why: 'nil _performOperations block crashes on launch (EXC_BAD_ACCESS at 0x10)',
    // The replacement names the ivar's block typedef, which the `before` anchor
    // does not mention. Fail on the declaration rather than on an Xcode error
    // three build phases later if a version ever inlines the block type.
    requires: ['REAPerformOperations _performOperations;'],
    before: [
      '- (void)performOperations',
      '{',
      '  RCTAssertMainQueue();',
      '  _performOperations(); // calls ReanimatedModuleProxy::performOperations',
      '}',
    ].join('\n'),
    after: [
      '- (void)performOperations',
      '{',
      '  RCTAssertMainQueue();',
      '  REAPerformOperations performOperations = _performOperations;',
      '  if (performOperations == nil) {',
      '    return;',
      '  }',
      '  performOperations(); // calls ReanimatedModuleProxy::performOperations',
      '}',
    ].join('\n'),
  },
];

/**
 * Whether `version` already carries the upstream fix, by semver ordering: a
 * prerelease sorts *below* the release it is cut from, because a nightly on the
 * fixed line can predate the commit that fixed it. Being wrong in that direction
 * costs a patch attempt: on a nightly that already carries the fix verbatim that
 * reports the source as already patched, and on one that carries it in some other
 * shape it fails as drift — loudly, and on a version this repo does not pin.
 *
 * @param {string} version
 * @param {string} fixedFrom
 * @returns {boolean}
 */
export function isFixedUpstream(version, fixedFrom) {
  const parse = (/** @type {string} */ value) => {
    // Build metadata (`+sha`) carries no ordering and is ignored, per semver.
    const match = /^(\d+)\.(\d+)\.(\d+)(-[^+]*)?(?:\+[\w.-]+)?$/.exec(value.trim());
    if (!match) throw new Error(`Cannot compare version ${JSON.stringify(value)}`);
    return {
      numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4] !== undefined,
    };
  };
  const candidate = parse(version);
  const fixed = parse(fixedFrom);
  if (fixed.prerelease) {
    // Comparing prerelease identifiers is not implemented, and guessing would let
    // an *older* prerelease on the same X.Y.Z count as fixed and skip the patch.
    throw new Error(`fixedFrom must name a released version, not ${JSON.stringify(fixedFrom)}`);
  }
  for (const [index, number] of candidate.numbers.entries()) {
    const target = fixed.numbers[index];
    if (number !== target) return number > target;
  }
  // Same X.Y.Z: only the full release carries the fix.
  return !candidate.prerelease;
}

/**
 * @param {NativePatch} patch
 * @param {string} source
 * @returns {{ status: 'patched' | 'already-patched', source: string }}
 */
export function applyNativePatch(patch, source) {
  // Before `requires`, which is a precondition of *writing* the replacement. A
  // patch whose `after` text removes one of its own needles would otherwise
  // succeed once and then fail on the source it had just written itself.
  if (source.includes(patch.after)) return { status: 'already-patched', source };
  // Anchors are LF-joined throughout. A CRLF checkout is a different problem from
  // upstream drift, and pointing at the wrong one costs an afternoon — so it is
  // answered for `requires` too, whose needles may span lines just as `before` does.
  const crlf = (/** @type {string} */ text) => source.includes(text.replaceAll('\n', '\r\n'));
  const lineEndings =
    'It is present with CRLF line endings, so the installed tree was ' +
    'line-ending-normalized rather than the source having changed.';

  const missing = patch.requires.filter((needle) => !source.includes(needle));
  if (missing.length > 0) {
    throw new Error(
      `${patch.package}: cannot patch ${patch.file} — the replacement depends on ` +
        `${missing.map((needle) => JSON.stringify(needle)).join(', ')}, which the installed ` +
        `source does not contain. ${missing.every(crlf) ? lineEndings : retireHint(patch)}`,
    );
  }
  const at = source.indexOf(patch.before);
  if (at === -1) {
    // `after` as well as `before`: a CRLF tree that already carries the backport
    // misses the short-circuit above for the same reason it misses this anchor, and
    // reporting that one as upstream drift sends the reader to the wrong repository.
    throw new Error(
      `${patch.package}: cannot patch ${patch.file} — the expected source is not there. ` +
        (crlf(patch.before) || crlf(patch.after) ? lineEndings : retireHint(patch)),
    );
  }
  if (source.indexOf(patch.before, at + 1) !== -1) {
    // Rewriting one of several identical anchors would leave the others unfixed
    // while still reporting success.
    throw new Error(
      `${patch.package}: cannot patch ${patch.file} — the expected source appears more ` +
        `than once, so the backport no longer identifies a single site. ${retireHint(patch)}`,
    );
  }
  // Spliced rather than String#replace, which would expand `$&` and friends in a
  // future patch's replacement text.
  const patched = source.slice(0, at) + patch.after + source.slice(at + patch.before.length);
  return { status: 'patched', source: patched };
}

/**
 * @param {NativePatch} patch
 * @returns {string}
 */
function retireHint(patch) {
  return (
    `The dependency is below ${patch.fixedFrom} but no longer matches the backport of ` +
    `${patch.reference}. Re-check the fix against the installed version, or upgrade to ` +
    `${patch.fixedFrom} or newer and delete this patch.`
  );
}

/**
 * The checkout a git worktree belongs to, or undefined for an ordinary checkout.
 *
 * A worktree's `.git` is a file naming the directory the owning checkout keeps its
 * administrative files in — `gitdir: ../../.git/worktrees/agent-x` — so the owner
 * is read out of this tree's own metadata rather than guessed at by looking for
 * repo-shaped ancestors. That matters because the answer authorizes a write outside
 * the working tree: manifests and a lockfile are three files anyone with write
 * access to a shared parent directory can create, and this link is not.
 *
 * @param {string} root
 * @returns {string | undefined}
 */
function owningCheckout(root) {
  let link;
  try {
    link = readFileSync(join(root, '.git'), 'utf8');
  } catch {
    // A directory (an ordinary checkout), or absent entirely — the EAS builder
    // unpacks an archive with no .git at all. Neither has an owner to resolve.
    return undefined;
  }
  const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(link)?.[1];
  if (gitdir === undefined) return undefined;
  const marker = `${sep}.git${sep}worktrees${sep}`;
  const resolved = resolve(root, gitdir);
  const at = resolved.indexOf(marker);
  if (at === -1) return undefined;
  const owner = resolved.slice(0, at);
  // Both ends checked, because a `.git` file outlives what it points at: a copied
  // tree, or one whose worktree git has since pruned, still names a path that may
  // now be an unrelated directory — and the answer authorizes a write into it.
  return existsSync(resolved) && existsSync(join(owner, '.git')) ? owner : undefined;
}

/**
 * Where the mobile app's prebuild reads `name` from: a nested install wins over the
 * hoisted one, the same resolution `scripts/mobile-native-lock-changes.mjs` models
 * against the lockfile. Patching the hoisted copy while prebuild compiles a nested
 * one would report success and ship the bug.
 *
 * The checkout that owns this one is searched after that, because this repo is also
 * checked out into session worktrees that have no node_modules of their own — the
 * parent checkout's is the tree Metro and prebuild resolve from there as well. That
 * one path writes outside the working tree, so it is taken from the worktree link
 * and nowhere else: an unrelated node_modules in a shared parent — a home directory,
 * /tmp, another project that happens to have an apps/mobile — is never a candidate.
 *
 * @param {string} repoRoot
 * @param {string} name
 * @returns {string}
 */
export function resolvePackageRoot(repoRoot, name) {
  const root = resolve(repoRoot);
  const candidates = [];
  // Inside the repo: every level Node itself consults, walking up from the app.
  for (let dir = join(root, MOBILE_WORKSPACE); ; dir = dirname(dir)) {
    candidates.push(join(dir, 'node_modules', name));
    if (dir === root || dirname(dir) === dir) break;
  }
  const owner = owningCheckout(root);
  if (owner !== undefined) candidates.push(join(owner, 'node_modules', name));
  const found = candidates.find((candidate) => existsSync(join(candidate, 'package.json')));
  if (found === undefined) {
    throw new Error(`${name} is not installed — run npm install at the repo root first.`);
  }
  return found;
}

/**
 * @param {NativePatch} patch
 * @param {string} repoRoot
 * @returns {string}
 */
export function runPatch(patch, repoRoot) {
  const packageRoot = resolvePackageRoot(repoRoot, patch.package);
  const manifestPath = join(packageRoot, 'package.json');
  /** @type {unknown} */
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (cause) {
    throw new Error(`${patch.package}: cannot read or parse ${manifestPath}`, { cause });
  }
  const { version } = /** @type {{ version?: unknown }} */ (manifest);
  if (typeof version !== 'string' || version === '') {
    throw new Error(`${patch.package}: installed package.json has no version.`);
  }
  let fixed;
  try {
    fixed = isFixedUpstream(version, patch.fixedFrom);
  } catch (cause) {
    // Naked, this reads as a bare "Cannot compare version" on the EAS builder,
    // naming neither the dependency nor what to do about it.
    throw new Error(
      `${patch.package}: cannot tell whether ${JSON.stringify(version)} carries the fix from ` +
        `${patch.fixedFrom}. Check the installed version by hand against ${patch.reference}.`,
      { cause },
    );
  }
  if (fixed) {
    return `${patch.package}@${version} — skipped, fixed upstream in ${patch.fixedFrom}; drop this patch.`;
  }

  const target = join(packageRoot, patch.file);
  let source;
  try {
    source = readFileSync(target, 'utf8');
  } catch (cause) {
    throw new Error(
      `${patch.package}@${version}: cannot read ${patch.file} — the file the backport of ` +
        `${patch.reference} rewrites is missing or unreadable in the installed package.`,
      { cause },
    );
  }
  const result = applyNativePatch(patch, source);
  if (result.status === 'patched') {
    // Written through a temporary file in the same directory and renamed: the tree
    // being rewritten can be a parent checkout's, shared with other session
    // worktrees, where a truncated .mm would be read by whatever ran concurrently.
    // Named for that too — a pid is unique within a namespace, and the sessions
    // sharing this mount do not share one — and created exclusively, so a name that
    // does exist is a collision to fail on rather than a file to write through.
    const staged = `${target}.patch-${randomUUID()}`;
    try {
      // The write is inside the try as well: a partial file from an ENOSPC is left
      // behind just the same, and while nothing compiles it — the podspec globs
      // `*.{h,m,mm}`, which this name is not — it is litter next to a source file
      // that the next run's reader has to rule out by hand.
      // Same mode as the file it replaces: npm installs sources read-only in some
      // configurations, and a rewrite should not quietly widen them. Chmod after the
      // write, because the mode a create honours is masked by the umask — which would
      // narrow the file instead, and narrowing breaks the next run just as well.
      const mode = statSync(target).mode & 0o777;
      writeFileSync(staged, result.source, { mode, flag: 'wx' });
      chmodSync(staged, mode);
      renameSync(staged, target);
    } catch (cause) {
      try {
        unlinkSync(staged);
      } catch {
        // Absent, or unremovable for the same reason the write failed. Either way
        // the error worth reporting is the one below.
      }
      throw new Error(
        `${patch.package}@${version}: cannot replace ${patch.file} in ${packageRoot}.`,
        { cause },
      );
    }
  }
  // The resolved root is part of the report because it is not always inside the
  // repo: a session worktree resolves into its parent checkout, and a run that
  // writes there should say so rather than leave it to be inferred.
  return (
    `${patch.package}@${version} — ${result.status}: ${patch.why} (${patch.reference}) ` +
    `in ${packageRoot}`
  );
}

/**
 * Runs every patch, reporting each one's outcome. A failure does not stop the
 * others: with one patch left unreported a second problem would only surface on
 * the next build, one at a time.
 *
 * The exit code is what breaks `eas-build-post-install`'s `&&` chain, so a build
 * that cannot be patched never reaches prebuild.
 *
 * @param {string} repoRoot
 * @param {{ log: (line: string) => void, error: (line: string) => void }} out
 * @param {NativePatch[]} [patches]
 * @returns {number} process exit code
 */
export function main(repoRoot, out, patches = NATIVE_PATCHES) {
  let failed = false;
  for (const patch of patches) {
    try {
      out.log(runPatch(patch, repoRoot));
    } catch (error) {
      // The EAS builder shows this straight to whoever triggered the build. The
      // crafted message plus its cause is the actionable part; a stack trace into
      // this file is not.
      const reason = error instanceof Error ? error.message : String(error);
      const cause =
        error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
      out.error(cause === undefined ? reason : `${reason} (${cause.message})`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

/**
 * True when this file is the process entry point. Both sides are realpath'd: Node
 * realpaths `import.meta.url`, and a symlinked entry (or a symlinked path
 * component, as `/tmp` is on macOS) would otherwise compare unequal — leaving the
 * script a silent no-op that exits 0 and lets an unpatched build proceed.
 *
 * @returns {boolean}
 */
function isEntryPoint() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  process.exitCode = main(repoRoot, {
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  });
}
