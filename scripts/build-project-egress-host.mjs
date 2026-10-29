import { build } from 'esbuild';
import { resolve } from 'node:path';
await build({
  entryPoints: ['packages/server/src/project-egress-host-main.ts'],
  outfile: 'packages/server/dist/project-egress-host-main.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node26',
  alias: { '@verity/store': resolve('packages/store/src/project-egress.ts') },
});
