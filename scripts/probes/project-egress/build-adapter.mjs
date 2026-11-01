import { build } from 'esbuild';
import { resolve } from 'node:path';
await build({
  entryPoints: ['scripts/probes/project-egress/adapter-smoke.ts'],
  outfile: 'scripts/probes/project-egress/adapter-smoke.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Bundle the source under test, never an unrelated or stale workspace dist.
  alias: { '@verity/store': resolve('packages/store/src/project-egress.ts') },
});

await build({
  entryPoints: ['scripts/probes/project-egress/host-smoke.ts'],
  outfile: 'scripts/probes/project-egress/host-smoke.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  alias: { '@verity/store': resolve('packages/store/src/project-egress.ts') },
});

await build({
  entryPoints: ['scripts/probes/project-egress/composed-renewal.ts'],
  outfile: 'scripts/probes/project-egress/composed-renewal.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
});
