#!/usr/bin/env node
// Compare native inputs, not every package in the JavaScript dependency closure.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/** @typedef {{hash: string, sources: Array<{id?: string, hash?: string | null}>}} NativeFingerprint */

/** @param {string} path */
export function nativePathKind(path) {
  if (
    /^apps\/mobile\/(?:ios|android|native|plugins|patches|cng-patches)\//u.test(path) ||
    /^scripts\/(?:patch-mobile-native-deps|prepare-mobile-eas-build)\.mjs$/u.test(path) ||
    /^apps\/mobile\/(?:fingerprint\.config\.[^/]+|\.fingerprintignore)$/u.test(path)
  )
    return 'native';
  if (
    /(?:^|\/)package(?:-lock)?\.json$/u.test(path) ||
    /^apps\/mobile\/(?:app\.(?:config\.[^/]+|json)|eas\.json|react-native\.config\.[^/]+)$/u.test(
      path,
    ) ||
    /^apps\/mobile\/assets\//u.test(path)
  )
    return 'fingerprint';
  return 'ota';
}

/** @param {NativeFingerprint} fingerprint */
export function validateFingerprint(fingerprint) {
  if (!fingerprint?.hash || !Array.isArray(fingerprint.sources))
    throw new Error('Invalid mobile native fingerprint');
  // Expo swallows autolinking errors. Missing discovery must not look compatible.
  for (const id of ['expoConfig', 'expoAutolinkingConfig:ios', 'rncoreAutolinkingConfig:ios']) {
    if (!fingerprint.sources.some((source) => source.id === id && source.hash))
      throw new Error(`Incomplete mobile native fingerprint: ${id}`);
  }
  if (fingerprint.sources.some((source) => !source.hash))
    throw new Error('Mobile native fingerprint contains an unreadable source');
  return fingerprint;
}

/**
 * @param {string[]} paths
 * @param {(ref: string) => NativeFingerprint | Promise<NativeFingerprint>} fingerprintAt
 * @param {string} baseRef
 * @param {string} headRef
 */
export async function nativeCompatibilityChanges(paths, fingerprintAt, baseRef, headRef) {
  const native = paths.filter((path) => nativePathKind(path) === 'native');
  if (native.length > 0) return native.map((path) => `Native input changed: ${path}`);
  if (!paths.some((path) => nativePathKind(path) === 'fingerprint')) return [];
  const base = validateFingerprint(await fingerprintAt(baseRef));
  const head = validateFingerprint(await fingerprintAt(headRef));
  return base.hash === head.hash ? [] : ['Mobile native fingerprint changed'];
}

// Run in a fresh process for each tree: Expo config and plugin require caches
// otherwise allow one tree's installed modules to contaminate the next result.
const fingerprintProgram = `
  console.log = (...args) => console.error(...args);
  const { createFingerprintAsync, SourceSkips, DEFAULT_SOURCE_SKIPS } = require(process.argv[1]);
  createFingerprintAsync(process.argv[2], {
    platforms: ['ios'], concurrentIoLimit: 1,
    sourceSkips: DEFAULT_SOURCE_SKIPS | SourceSkips.ExpoConfigVersions | SourceSkips.ExpoConfigRuntimeVersionIfString,
  }).then(result => process.stdout.write(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
`;

/** @param {string} root @param {string} tool */
export function fingerprintInstalledTree(root, tool = require.resolve('@expo/fingerprint')) {
  const env = { ...process.env, CI: '1', EXPO_NO_DOTENV: '1' };
  delete env.VERITY_IOS_BUILD_NUMBER;
  delete env.EAS_BUILD;
  /** @type {unknown} */
  const result = JSON.parse(
    execFileSync(process.execPath, ['-e', fingerprintProgram, tool, join(root, 'apps/mobile')], {
      cwd: root,
      env,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  );
  return validateFingerprint(/** @type {NativeFingerprint} */ (result));
}

/** @param {string} baseRef @param {string} headRef */
export async function compareNativeRefs(baseRef, headRef = 'HEAD') {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const refs = [baseRef, headRef].map((ref) =>
    execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
  );
  const paths = execFileSync('git', ['diff', '--name-only', '-z', refs[0], refs[1], '--'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  /** @type {string | undefined} */
  let temporary;
  /** @type {string | undefined} */
  let tool;
  try {
    return await nativeCompatibilityChanges(
      paths,
      (ref) => {
        tool ??= require.resolve('@expo/fingerprint');
        temporary ??= mkdtempSync(join(tmpdir(), 'verity-native-compatibility-'));
        const tree = join(temporary, 'tree');
        mkdirSync(tree);
        const archive = join(temporary, 'tree.tar');
        try {
          execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, ref], {
            cwd: root,
          });
          execFileSync('tar', ['-xf', archive, '-C', tree]);
          const env = { ...process.env, CI: '1', EXPO_NO_DOTENV: '1' };
          delete env.EAS_BUILD;
          execFileSync('npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error'], {
            cwd: tree,
            env,
            stdio: ['ignore', 2, 2],
          });
          return fingerprintInstalledTree(tree, tool);
        } finally {
          rmSync(tree, { recursive: true, force: true });
          rmSync(archive, { force: true });
        }
      },
      refs[0],
      refs[1],
    );
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [base, head = 'HEAD'] = process.argv.slice(2);
  try {
    if (!base) throw new Error('Usage: mobile-native-compatibility.mjs <base> [head]');
    for (const reason of await compareNativeRefs(base, head)) console.log(reason);
  } catch (error) {
    console.error(`Could not verify mobile native compatibility: ${String(error)}`);
    process.exitCode = 1;
  }
}
