import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const outfile = 'features/verity-sandbox-toolkit/bin/verity-runner-worker.mjs';
const entryPoint = 'packages/session/dist/runner-worker-entry.js';
const workerPackage = '@verity/session';
// Replaced at bundle time, so nothing this resolves to ships in the artifact.
const bundleAliases = { '@verity/store': resolve('scripts/runner-worker-store-shim.mjs') };
const check = process.argv.includes('--check');
const buildTarget = check ? `${outfile}.check` : outfile;

/** @param {string} path */
async function normalizeBundleComments(path) {
  const bundled = await readFile(path, 'utf8');
  const normalized = bundled
    .replace(/^\/\/ (?:\.\.\/)+node_modules\//gm, '// node_modules/')
    .replace(/[ \t]+$/gm, '');
  if (normalized !== bundled) await writeFile(path, normalized);
}

// esbuild bundles `dist`, not the TypeScript beside it, so this script is only
// ever as current as the last compile. Run directly rather than through
// `npm run build:runner-worker`, it will bundle whatever was compiled last —
// and `--check` then compares that same stale build against the committed file
// and passes, so a local run reports the committed worker as reproducible while
// it is missing the very change being tested. CI compiles first and is left to
// find it, as a bundle diff rather than as "you forgot to rebuild".
//
// So compile before bundling, and let what ships decide what is fatal. `tsc -b`
// builds the worker package together with the projects it references, which is
// wider than the bundle: `@verity/store` is aliased away below, and a package
// whose code never reaches the artifact cannot make the artifact stale — failing
// on it would wedge this script in any tree where something unrelated does not
// build. Type-checking the repo stays `npm run build`'s job.
//
// So the graph's errors are read against the set of packages actually bundled,
// and an error naming one of those is fatal. An error naming nothing is fatal
// too whenever the build failed: a crash, a `TS5083: Cannot read file`, and
// build mode's own "can't be built because its dependency has errors" all land
// there, and that last one is precisely a package silently left uncompiled.
// Resolved rather than pathed: workspace installs hoist, and this repo is
// checked out into worktrees whose node_modules is the root one.
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
/** @param {string[]} args */
function runTsc(args) {
  const run = spawnSync(process.execPath, [tsc, ...args], { encoding: 'utf8' });
  if (run.error !== undefined) throw run.error;
  const text = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (text !== '') process.stderr.write(text);
  if (run.signal !== null) throw new Error(`tsc was killed by ${run.signal}; the dist is stale`);
  return { status: run.status, text };
}

/**
 * The directories under `packages/` whose emitted JavaScript ends up inside the
 * bundle: the worker's own package plus its workspace dependencies,
 * transitively, minus the ones esbuild replaces with a shim. Derived from the
 * same alias map the bundle is built with, so the two cannot drift apart.
 */
function bundledPackageDirs() {
  /** @type {Map<string, { dir: string; deps: string[] }>} */
  const manifests = new Map();
  for (const dir of readdirSync('packages')) {
    try {
      const parsed = /** @type {unknown} */ (
        JSON.parse(readFileSync(`packages/${dir}/package.json`, 'utf8'))
      );
      const { name, dependencies } = /** @type {{ name?: unknown; dependencies?: unknown }} */ (
        parsed ?? {}
      );
      if (typeof name !== 'string') continue;
      const deps = typeof dependencies === 'object' && dependencies !== null ? dependencies : {};
      manifests.set(name, { dir, deps: Object.keys(deps) });
    } catch {
      // Not a workspace package; nothing of it can be bundled.
    }
  }
  const shimmed = new Set(Object.keys(bundleAliases));
  /** @type {Set<string>} */
  const dirs = new Set();
  const pending = [workerPackage];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    const manifest = manifests.get(name);
    if (manifest === undefined || shimmed.has(name) || dirs.has(manifest.dir)) continue;
    dirs.add(manifest.dir);
    pending.push(...manifest.deps.filter((dep) => manifests.has(dep)));
  }
  return dirs;
}

const bundled = bundledPackageDirs();
const compiled = runTsc(['-b', 'packages/session']);
const failures = compiled.text.split('\n').filter((line) => /error TS\d+/u.test(line));
const packages = failures.map((line) => /^packages\/([^/]+)\//u.exec(line)?.[1]);
if (packages.some((name) => name !== undefined && bundled.has(name))) {
  throw new Error('a bundled package did not compile; its dist is stale');
}
if (compiled.status !== 0 && (failures.length === 0 || packages.includes(undefined))) {
  throw new Error('the worker bundle graph did not compile cleanly; its dist may be stale');
}
// And the worker package once more on its own, which no reading of someone
// else's diagnostics can stand in for: a build mode that refuses to emit a
// dependent after its dependency failed says so about the dependency, and
// `packages/session` would go uncompiled with nothing above naming it. Compiled
// alone, against the declarations the graph build left, it answers by exit code.
const emitted = runTsc(['-p', 'packages/session/tsconfig.json']);
if (emitted.status !== 0) {
  throw new Error('packages/session did not compile; its dist is stale');
}

await build({
  entryPoints: [entryPoint],
  outfile: buildTarget,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'bundle',
  preserveSymlinks: true,
  alias: bundleAliases,
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: false,
});
await normalizeBundleComments(buildTarget);
if (check) {
  const [expected, actual] = await Promise.all([readFile(outfile), readFile(buildTarget)]);
  await rm(buildTarget, { force: true });
  if (!expected.equals(actual)) throw new Error('bundled runner worker is out of date');
} else {
  await chmod(outfile, 0o755);
}
