import { build } from 'esbuild';
import { readFile, rm } from 'node:fs/promises';
import { basename } from 'node:path';

// The spawn broker and the Runner supervisor are boundary binaries: the Server
// hashes each shipped file as one self-contained executable
// (packages/server/src/runner-boundary-attestation.ts, the toolkit ledger), so
// what ships must stay one file. Their sources are modules under
// features/verity-sandbox-toolkit/src/, kept within the file-size limit
// (docs/adr/0029-module-boundaries-and-file-size.md), and bundled here into the
// paths the installer and the ledger already name. Edit the sources, then run
// `npm run build:toolkit-bundles`; `--check` fails when a committed bundle is
// out of date.
//
// The file-size guard reads the `outfile:` lines below to skip these bundles as
// generated output, so keep one per line.
const bundles = [
  {
    entry: 'features/verity-sandbox-toolkit/src/spawn-broker/main.mjs',
    outfile: 'features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs',
  },
  {
    entry: 'features/verity-sandbox-toolkit/src/runner-supervisor/main.mjs',
    outfile: 'features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs',
  },
];

// Sibling executables in bin/ stay imports of the shipped file, exactly as before
// the sources moved: they ship and install on their own, and some of them start
// themselves from `import.meta.url` (verity-memory-guard.mjs re-execs itself), so
// inlining them would run their entry inside the broker.
const siblingExecutables = {
  name: 'toolkit-sibling-executables',
  setup(build) {
    build.onResolve({ filter: /^\.\.\/\.\.\/bin\/verity-[\w-]+\.mjs$/ }, (args) => ({
      path: `./${basename(args.path)}`,
      external: true,
    }));
  },
};

const check = process.argv.includes('--check');
const stale = [];
for (const { entry, outfile } of bundles) {
  const target = check ? `${outfile}.check` : outfile;
  await build({
    entryPoints: [entry],
    outfile: target,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    // The sources under src/ are bundled in; Node built-ins and the sibling
    // executables above stay imports.
    packages: 'bundle',
    plugins: [siblingExecutables],
    banner: { js: '#!/usr/bin/env node' },
    sourcemap: false,
    legalComments: 'none',
  });
  if (check) {
    const [expected, actual] = await Promise.all([
      readFile(outfile).catch(() => Buffer.alloc(0)),
      readFile(target),
    ]);
    await rm(target, { force: true });
    if (!expected.equals(actual)) stale.push(outfile);
  }
}
if (stale.length > 0) {
  throw new Error(
    `out of date, run npm run build:toolkit-bundles and commit the result: ${stale.join(', ')}`,
  );
}
