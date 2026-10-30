/** Assemble only the installed dependency closure; preserve native/WASM package assets. */
import { build } from 'esbuild';
import { cp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { isBuiltin } from 'node:module';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve('.');
const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const visited = new Set();
async function locate(name, from) {
  for (let parent = from; ; parent = dirname(parent)) {
    const candidate = join(parent, 'node_modules', name);
    try {
      return { path: candidate, real: await realpath(candidate) };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (parent === dirname(parent))
      throw new Error(`Missing installed dependency ${name} from ${from}`);
  }
}
async function include(name, from, optional = false) {
  let found;
  try {
    found = await locate(name, from);
  } catch (error) {
    if (optional) return;
    throw error;
  }
  const destination = join(output, relative(root, found.real));
  if (!found.real.startsWith(`${root}/`)) throw new Error('Dependency outside checkout');
  if (found.path !== found.real) {
    const link = join(output, relative(root, found.path));
    await mkdir(dirname(link), { recursive: true });
    await symlink(relative(dirname(link), destination), link).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
  }
  if (visited.has(found.real)) return;
  visited.add(found.real);
  await mkdir(dirname(destination), { recursive: true });
  await cp(found.real, destination, {
    recursive: true,
    filter: (path) => !/\/(?:node_modules|\.cache)(?:\/|$)/u.test(relative(found.real, path)),
  });
  const manifest = JSON.parse(await readFile(join(found.real, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies ?? {}))
    await include(dependency, found.real);
  for (const dependency of Object.keys(manifest.optionalDependencies ?? {}))
    await include(dependency, found.real, true);
}
for (const name of ['@verity/server', '@electric-sql/pglite']) await include(name, root);
await writeFile(join(output, 'package.json'), '{"type":"module"}\n');
await build({
  entryPoints: ['scripts/probes/project-egress/boot-server.ts'],
  outfile: join(output, 'boot-server.mjs'),
  bundle: true,
  plugins: [
    {
      name: 'preserve-package-resolution',
      setup(bundler) {
        bundler.onResolve({ filter: /^[^./]/ }, async (args) => {
          if (isBuiltin(args.path) || args.pluginData?.resolved) return;
          const result = await bundler.resolve(args.path, {
            resolveDir: args.resolveDir,
            kind: args.kind,
            pluginData: { resolved: true },
          });
          if (result.errors.length) return { errors: result.errors };
          if (!result.path.startsWith(`${root}/`)) throw new Error('Import outside checkout');
          // The entry bundle moves to the guest root; bare imports would lose
          // the source package's nested dependency lookup and version selection.
          return { path: `./${relative(root, result.path)}`, external: true };
        });
      },
    },
  ],
  platform: 'node',
  format: 'esm',
  target: 'node26',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
// Load all eager imports without allowing ancestor node_modules to hide missing
// guest assets. Only the image's optional version stamps live outside the bundle.
const smoke = spawnSync(
  process.execPath,
  [
    '--permission',
    `--allow-fs-read=${output}`,
    '--allow-fs-read=/app/.verity-server-version',
    '--allow-fs-read=/app/.verity-schema-forward-max',
    join(output, 'boot-server.mjs'),
  ],
  { encoding: 'utf8', env: { ...process.env, PROJECT_EGRESS_DISPOSABLE: '' } },
);
assert.equal(smoke.status, 1, smoke.stderr);
assert.match(smoke.stderr, /AssertionError \[ERR_ASSERTION\]/u);
assert.match(smoke.stderr, /'' !== 'yes'/u, smoke.stderr);
await cp('agent-seed', join(output, 'agent-seed'), { recursive: true });
await cp('scripts/probes/project-egress', join(output, 'probe'), {
  recursive: true,
  filter: (path) => !path.endsWith('__pycache__'),
});
await cp('deploy/egress', join(output, 'units'), { recursive: true });
await cp(
  'packages/server/dist/project-egress-host-main.mjs',
  join(output, 'project-egress-host-main.mjs'),
);
