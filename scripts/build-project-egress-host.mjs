import { build } from 'esbuild';
import { resolve } from 'node:path';
await build({
  entryPoints: ['packages/server/src/project-egress-host-main.ts'],
  outfile: 'packages/server/dist/project-egress-host-main.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node26',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  alias: { '@verity/store': resolve('packages/store/src/index.ts') },
});
