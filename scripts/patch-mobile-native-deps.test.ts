import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  NATIVE_PATCHES,
  applyNativePatch,
  isFixedUpstream,
  main,
  resolvePackageRoot,
  runPatch,
  // @ts-expect-error -- plain .mjs helper, no types
} from './patch-mobile-native-deps.mjs';

// The runner is a `.mjs` imported without types, so this is a hand copy of its
// typedef and has to carry every field: a fixture built from a type missing one
// still type-checks, and the runner then reads undefined out of it at runtime.
type NativePatch = {
  package: string;
  file: string;
  fixedFrom: string;
  reference: string;
  why: string;
  requires: string[];
  before: string;
  after: string;
};

const patches: NativePatch[] = NATIVE_PATCHES;
const reanimated = patches.find((patch) => patch.package === 'react-native-reanimated');
// Half of this suite is about that one backport, so retiring it retires them: say so
// here rather than letting every test in the file die on a TypeError that names none
// of this.
if (reanimated === undefined) {
  throw new Error(
    'react-native-reanimated has no entry in NATIVE_PATCHES. If the backport was ' +
      'retired, delete the tests that describe it — the ones about the runner itself ' +
      'do not need it.',
  );
}
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const installed = ((): { packageRoot: string; version: string } | undefined => {
  let packageRoot: string;
  try {
    packageRoot = resolvePackageRoot(repoRoot, reanimated.package);
  } catch (error) {
    // Only "the mobile workspace's dependencies were never installed here" may skip
    // the drift check — a broader catch would turn any failure into a green run and
    // silently retire the one test that validates the anchors against the real tree.
    if (error instanceof Error && error.message.includes('is not installed')) return undefined;
    throw error;
  }
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    version: string;
  };
  return { packageRoot, version: manifest.version };
})();

const roots: string[] = [];

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'patch-native-'));
  roots.push(root);
  return root;
}

/** An install of `patch` at `version`, under `at` (repo root by default). */
function installCopy(
  root: string,
  patch: NativePatch,
  version: string,
  source: string,
  at: string[] = [],
) {
  const packageRoot = join(root, ...at, 'node_modules', patch.package);
  mkdirSync(join(packageRoot, dirname(patch.file)), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(packageRoot, patch.file), source);
  return join(packageRoot, patch.file);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('mobile native dependency patches', () => {
  it('skips a dependency that already carries the upstream fix', () => {
    expect(isFixedUpstream('4.6.0', '4.6.0')).toBe(true);
    expect(isFixedUpstream('4.6.1', '4.6.0')).toBe(true);
    expect(isFixedUpstream('5.0.0', '4.6.0')).toBe(true);
    expect(isFixedUpstream('4.5.3', '4.6.0')).toBe(false);
    expect(isFixedUpstream('4.3.1', '4.6.0')).toBe(false);
    expect(isFixedUpstream('3.19.5', '4.6.0')).toBe(false);
  });

  it('treats a prerelease as below the release it is cut from', () => {
    // A nightly on the fixed line can predate the commit that fixed it, so it is
    // patched (and then reported as already patched if it does carry the fix).
    expect(isFixedUpstream('4.6.0-nightly-20260804-460019806', '4.6.0')).toBe(false);
    expect(isFixedUpstream('4.7.0-nightly-20260824-0788fcdeb', '4.6.0')).toBe(true);
  });

  it('keeps every patch distinguishable from its own replacement', () => {
    // What makes the already-patched short-circuit sound: if `after` were part of
    // the source `before` matches, every run would report the unpatched file as
    // already patched and ship the bug.
    for (const patch of patches) {
      expect(patch.after, `${patch.package}: the replacement is not a rewrite`).not.toBe(
        patch.before,
      );
      expect(
        patch.before,
        `${patch.package}: the unpatched source contains its own fix`,
      ).not.toContain(patch.after);
    }
  });

  it('rewrites the unfixed source exactly once', () => {
    const source = `${reanimated.requires.join('\n')}\n${reanimated.before}\nsuffix\n`;
    const first = applyNativePatch(reanimated, source);
    expect(first.status).toBe('patched');
    expect(first.source).toBe(`${reanimated.requires.join('\n')}\n${reanimated.after}\nsuffix\n`);

    const second = applyNativePatch(reanimated, first.source);
    expect(second.status).toBe('already-patched');
    expect(second.source).toBe(first.source);
  });

  it('fails loudly when an unfixed dependency no longer matches the backport', () => {
    const drifted = `${reanimated.requires.join('\n')}\nunrelated source\n`;
    expect(() => applyNativePatch(reanimated, drifted)).toThrow(/expected source is not there/);
  });

  it('fails when the replacement depends on a declaration that is gone', () => {
    expect(() => applyNativePatch(reanimated, `${reanimated.before}\n`)).toThrow(
      /replacement depends on/,
    );
  });

  it('stays idempotent for a patch whose replacement drops one of its needles', () => {
    // `requires` is a precondition of writing the replacement, not of recognizing
    // one already written. Checked in the other order, such a patch applies once
    // and then fails on its own output, which on the builder reads as drift.
    const consuming = { ...reanimated, after: 'rewritten without the declaration' };
    const first = applyNativePatch(
      consuming,
      `${consuming.requires.join('\n')}\n${consuming.before}\n`,
    );
    expect(first.status).toBe('patched');
    expect(applyNativePatch(consuming, first.source).status).toBe('already-patched');
  });

  it('patches the hoisted install', () => {
    const root = makeRoot();
    const source = `${reanimated.requires.join('\n')}\n${reanimated.before}\n`;
    const hoisted = installCopy(root, reanimated, '4.3.1', source);

    expect(runPatch(reanimated, root)).toMatch(/— patched:/);
    expect(readFileSync(hoisted, 'utf8')).toContain(reanimated.after);
  });

  it('patches the nested install prebuild would resolve, not the hoisted copy', () => {
    const root = makeRoot();
    const source = `${reanimated.requires.join('\n')}\n${reanimated.before}\n`;
    const hoisted = installCopy(root, reanimated, '4.3.1', source);
    const nested = installCopy(root, reanimated, '4.3.1', source, ['apps', 'mobile']);

    expect(resolvePackageRoot(root, reanimated.package)).toContain(
      join('apps', 'mobile', 'node_modules'),
    );
    expect(runPatch(reanimated, root)).toMatch(/— patched:/);
    expect(readFileSync(nested, 'utf8')).toContain(reanimated.after);
    expect(readFileSync(hoisted, 'utf8')).toBe(source);
  });

  it('consults apps/node_modules, the level Node resolves second', () => {
    const root = makeRoot();
    const source = `${reanimated.requires.join('\n')}\n${reanimated.before}\n`;
    const hoisted = installCopy(root, reanimated, '4.3.1', source);
    const intermediate = installCopy(root, reanimated, '4.3.1', source, ['apps']);

    expect(runPatch(reanimated, root)).toMatch(/— patched:/);
    expect(readFileSync(intermediate, 'utf8')).toContain(reanimated.after);
    expect(readFileSync(hoisted, 'utf8')).toBe(source);
  });

  it('ignores a node_modules above the repo that this tree is not a worktree of', () => {
    const parent = makeRoot();
    const root = join(parent, 'checkout');
    mkdirSync(root, { recursive: true });
    const source = `${reanimated.requires.join('\n')}\n${reanimated.before}\n`;
    const outside = installCopy(parent, reanimated, '4.3.1', source);

    // A directory that merely holds a node_modules — a home directory, /tmp — is
    // not this repo's install tree; writing into it would patch something else.
    expect(() => runPatch(reanimated, root)).toThrow(/is not installed/);
    expect(readFileSync(outside, 'utf8')).toBe(source);

    // Nor is one that a writable shared parent has been dressed up as this repo:
    // manifests and a lockfile are files anyone with access there can create, and
    // none of them is what makes a parent checkout's node_modules the one this
    // tree resolves through.
    mkdirSync(join(parent, 'apps', 'mobile'), { recursive: true });
    writeFileSync(
      join(parent, 'apps', 'mobile', 'package.json'),
      JSON.stringify({ name: '@verity/mobile-app' }),
    );
    writeFileSync(join(parent, 'package.json'), JSON.stringify({ name: 'verity' }));
    writeFileSync(join(parent, 'package-lock.json'), '{}');
    expect(() => runPatch(reanimated, root)).toThrow(/is not installed/);
    expect(readFileSync(outside, 'utf8')).toBe(source);

    // What does: this tree's own .git naming the checkout that owns the worktree,
    // which is where its node_modules actually lives.
    mkdirSync(join(parent, '.git', 'worktrees', 'agent-1'), { recursive: true });
    writeFileSync(join(root, '.git'), 'gitdir: ../.git/worktrees/agent-1\n');
    expect(runPatch(reanimated, root)).toMatch(/— patched:/);
    expect(readFileSync(outside, 'utf8')).toContain(reanimated.after);
  });

  it('ignores a .git that points somewhere other than a worktree', () => {
    const parent = makeRoot();
    const root = join(parent, 'checkout');
    mkdirSync(root, { recursive: true });
    const source = `${reanimated.requires.join('\n')}\n${reanimated.before}\n`;
    const outside = installCopy(parent, reanimated, '4.3.1', source);

    // A submodule's .git points at `.git/modules/...`, not at a worktree, and the
    // parent it names is not a checkout this tree shares an install with.
    writeFileSync(join(root, '.git'), 'gitdir: ../.git/modules/checkout\n');
    expect(() => runPatch(reanimated, root)).toThrow(/is not installed/);
    expect(readFileSync(outside, 'utf8')).toBe(source);
  });

  it('ignores a worktree link whose owner is gone', () => {
    const parent = makeRoot();
    const root = join(parent, 'checkout');
    mkdirSync(root, { recursive: true });
    const source = `${reanimated.requires.join('\n')}\n${reanimated.before}\n`;
    const outside = installCopy(parent, reanimated, '4.3.1', source);

    // A .git file outlives what it names: the worktree gets pruned, or the tree is
    // copied somewhere else entirely, and the path it points at is then whatever
    // else lives there. Nothing about that directory says it is a checkout sharing
    // an install with this tree, so it is not written into.
    writeFileSync(join(root, '.git'), 'gitdir: ../.git/worktrees/agent-1\n');
    expect(() => runPatch(reanimated, root)).toThrow(/is not installed/);
    expect(readFileSync(outside, 'utf8')).toBe(source);
  });

  it('re-runs over a real file without touching it twice', () => {
    const root = makeRoot();
    const target = installCopy(
      root,
      reanimated,
      '4.3.1',
      `${reanimated.requires.join('\n')}\n${reanimated.before}\n`,
    );
    expect(runPatch(reanimated, root)).toMatch(/— patched:/);
    const patched = readFileSync(target, 'utf8');
    expect(runPatch(reanimated, root)).toMatch(/— already-patched:/);
    expect(readFileSync(target, 'utf8')).toBe(patched);
    // The staged file the rewrite renames from must not be left behind next to the
    // source, where the next reader has to work out what it is.
    expect(readdirSync(dirname(target))).toEqual(['REANodesManager.mm']);
  });

  it('leaves the patched file the mode it found', () => {
    const root = makeRoot();
    const target = installCopy(
      root,
      reanimated,
      '4.3.1',
      `${reanimated.requires.join('\n')}\n${reanimated.before}\n`,
    );
    // npm installs package sources read-only in some configurations, and the
    // rewrite goes through a fresh file — so the mode is carried over explicitly
    // or it silently becomes whatever the umask says.
    chmodSync(target, 0o444);

    expect(runPatch(reanimated, root)).toMatch(/— patched:/);
    expect(statSync(target).mode & 0o777).toBe(0o444);
  });

  it.skipIf(process.getuid?.() === 0)('cleans up after a write it could not finish', () => {
    const root = makeRoot();
    const source = `${reanimated.requires.join('\n')}\n${reanimated.before}\n`;
    const target = installCopy(root, reanimated, '4.3.1', source);
    // A directory the staged file cannot be created in stands in for the disk
    // filling up: what matters is that the source is left intact and nothing
    // half-written is left next to it.
    chmodSync(dirname(target), 0o555);

    try {
      expect(() => runPatch(reanimated, root)).toThrow(/cannot replace/);
      expect(readFileSync(target, 'utf8')).toBe(source);
      expect(readdirSync(dirname(target))).toEqual(['REANodesManager.mm']);
    } finally {
      chmodSync(dirname(target), 0o755);
    }
  });

  it('names line endings, not upstream drift, when the tree is CRLF', () => {
    const crlf = `${reanimated.requires.join('\n')}\n${reanimated.before}\n`.replaceAll(
      '\n',
      '\r\n',
    );
    expect(() => applyNativePatch(reanimated, crlf)).toThrow(/CRLF line endings/);
  });

  it('names the dependency when the installed version cannot be compared', () => {
    const root = makeRoot();
    installCopy(root, reanimated, 'next', 'x');
    expect(() => runPatch(reanimated, root)).toThrow(
      /react-native-reanimated: cannot tell whether "next"/,
    );
  });

  it('runs through a symlinked entry point instead of exiting green', () => {
    // A guard that compares paths without realpath is a silent no-op: the script
    // does nothing, exits 0, and the release workflow ships an unpatched build.
    const root = makeRoot();
    const target = installCopy(
      root,
      reanimated,
      '4.3.1',
      `${reanimated.requires.join('\n')}\n${reanimated.before}\n`,
    );
    mkdirSync(join(root, 'scripts'));
    const script = join(root, 'scripts', 'patch-mobile-native-deps.mjs');
    copyFileSync(join(repoRoot, 'scripts', 'patch-mobile-native-deps.mjs'), script);
    symlinkSync(script, join(root, 'entry.mjs'));

    const stdout = execFileSync(process.execPath, [join(root, 'entry.mjs')], { encoding: 'utf8' });
    expect(stdout).toMatch(/— patched:/);
    expect(readFileSync(target, 'utf8')).toContain(reanimated.after);
  });

  it('refuses to guess at a version it cannot parse', () => {
    expect(() => isFixedUpstream('next', '4.6.0')).toThrow(/Cannot compare version/);
  });

  it('keeps the mobile patch entry point resolvable', () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, 'apps', 'mobile', 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };

    // The npm script runs from `apps/mobile`, so the relative path it names has to
    // resolve from there. Moving or renaming this file would otherwise leave every
    // test green and fail on the builder with MODULE_NOT_FOUND, inside a hook no
    // CI job runs from anywhere but a full checkout.
    const runner = /^node (\S+)$/.exec(manifest.scripts['patch:native'])?.[1];
    expect(runner, 'patch:native no longer runs a single script').toBeDefined();
    expect(existsSync(join(repoRoot, 'apps', 'mobile', runner ?? ''))).toBe(true);
  });

  /**
   * The forcing function for retirement. Each patch skips itself once the
   * dependency reaches `fixedFrom`, which is the safe behavior but a silent one:
   * the machinery would then sit in the repo indefinitely, applied by a build step
   * that does nothing. Read from the lockfile rather than an install, so it fails
   * in the `test` job on the commit that bumps the dependency.
   */
  it('fails once a patched dependency is upgraded past the fix', () => {
    const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string }>;
    };
    for (const patch of patches) {
      const versions = Object.entries(lock.packages)
        .filter(([path]) => path.endsWith(`node_modules/${patch.package}`))
        .map(([, entry]) => entry.version)
        .filter((version): version is string => typeof version === 'string');
      expect(
        versions.length,
        `${patch.package} is patched but not in the lockfile`,
      ).toBeGreaterThan(0);
      for (const version of versions) {
        expect(
          isFixedUpstream(version, patch.fixedFrom),
          `${patch.package}@${version} carries the upstream fix from ${patch.fixedFrom} — ` +
            'delete its entry in NATIVE_PATCHES, and the patch step with it if it was the last',
        ).toBe(false);
      }
    }
  });

  it('rejects a prerelease as the version a patch retires at', () => {
    // Ordering prerelease identifiers is not implemented; guessing would let an
    // older nightly on the fixed line skip the patch.
    expect(() => isFixedUpstream('4.6.0-nightly-a', '4.6.0-nightly-b')).toThrow(
      /must name a released version/,
    );
  });

  it('reports an installed dependency whose patched file is gone', () => {
    const root = makeRoot();
    const target = installCopy(root, reanimated, '4.3.1', 'x');
    rmSync(target);
    expect(() => runPatch(reanimated, root)).toThrow(/cannot read .*REANodesManager\.mm/);
  });

  it('reports an installed dependency with no version', () => {
    const root = makeRoot();
    installCopy(root, reanimated, '4.3.1', 'x');
    writeFileSync(join(root, 'node_modules', reanimated.package, 'package.json'), '{}');
    expect(() => runPatch(reanimated, root)).toThrow(/has no version/);
  });

  it('exits non-zero and names the cause when a patch cannot be applied', () => {
    const root = makeRoot();
    // The workflow shell is fail-fast, so this exit code is what keeps a
    // build that could not be patched from reaching prebuild.
    const lines: string[] = [];
    const errors: string[] = [];
    expect(
      main(root, { log: (l: string) => lines.push(l), error: (e: string) => errors.push(e) }),
    ).toBe(1);
    expect(lines).toEqual([]);
    expect(errors.join('\n')).toMatch(/is not installed/);
  });

  it('exits zero and reports every patch it applied', () => {
    const root = makeRoot();
    for (const patch of patches) {
      installCopy(root, patch, '0.0.0', `${patch.requires.join('\n')}\n${patch.before}\n`);
    }
    const lines: string[] = [];
    const errors: string[] = [];
    expect(
      main(root, { log: (l: string) => lines.push(l), error: (e: string) => errors.push(e) }),
    ).toBe(0);
    expect(errors).toEqual([]);
    expect(lines).toHaveLength(patches.length);
    expect(lines.every((line) => line.includes('— patched:'))).toBe(true);
  });

  it('reports a later patch even when an earlier one fails', () => {
    const root = makeRoot();
    const other = { ...reanimated, package: 'another-native-dep' };
    installCopy(root, other, '0.0.0', `${other.requires.join('\n')}\n${other.before}\n`);

    const lines: string[] = [];
    const errors: string[] = [];
    expect(
      main(root, { log: (l: string) => lines.push(l), error: (e: string) => errors.push(e) }, [
        reanimated,
        other,
      ]),
    ).toBe(1);
    // One failure must not hide the rest: the next build would report them one at
    // a time, which is the slowest possible way to learn about two problems.
    expect(errors.join('\n')).toMatch(/react-native-reanimated is not installed/);
    expect(lines.join('\n')).toMatch(/another-native-dep@0\.0\.0 — patched:/);
  });

  it('refuses to patch when the anchor is no longer unique', () => {
    const doubled = `${reanimated.requires.join('\n')}\n${reanimated.before}\n${reanimated.before}\n`;
    expect(() => applyNativePatch(reanimated, doubled)).toThrow(/appears more than once/);
  });

  it('ignores build metadata when comparing versions', () => {
    expect(isFixedUpstream('4.6.0+sha.abc123', '4.6.0')).toBe(true);
    expect(isFixedUpstream('4.3.1+sha.abc123', '4.6.0')).toBe(false);
  });

  it('leaves a fixed version untouched', () => {
    const root = makeRoot();
    const target = installCopy(root, reanimated, '4.6.0', 'anything at all\n');
    expect(runPatch(reanimated, root)).toMatch(/skipped, fixed upstream in 4\.6\.0/);
    expect(readFileSync(target, 'utf8')).toBe('anything at all\n');
  });

  it('reports a dependency that is not installed', () => {
    expect(() => runPatch(reanimated, makeRoot())).toThrow(/is not installed/);
  });

  it.skipIf(installed === undefined)('matches the installed react-native-reanimated source', () => {
    // The point of the patch is what prebuild copies into the Xcode project, so
    // anchor drift detection to the tree that gets copied, not to a fixture.
    // This runs wherever the mobile workspace is installed (a dev machine, a
    // session sandbox); CI's `test` job installs only `packages`, and the
    // `mobile-app` job covers it there by running `patch:native` for real.
    const { packageRoot, version } = installed!;
    if (isFixedUpstream(version, reanimated.fixedFrom)) {
      // Upgrading past the fix is the retirement path, not drift: upstream owns
      // that source again and may rewrite it freely — including moving or renaming
      // the file, so it must not be read here. Assert the retirement instead.
      expect(runPatch(reanimated, repoRoot)).toMatch(/skipped, fixed upstream/);
      return;
    }
    // Below the fix the read is unguarded, because an unreadable file IS drift.
    const source = readFileSync(join(packageRoot, reanimated.file), 'utf8');
    for (const needle of reanimated.requires) expect(source).toContain(needle);
    expect(source.includes(reanimated.before) || source.includes(reanimated.after)).toBe(true);
  });
});
