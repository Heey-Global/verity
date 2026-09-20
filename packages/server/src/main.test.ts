import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const sourceRoot = 'packages/server/src';

describe('deployment runtime imports', () => {
  it('selects the runtime before importing its dependencies', async () => {
    const { metafile } = await build({
      entryPoints: [`${sourceRoot}/main.ts`],
      bundle: true,
      platform: 'node',
      format: 'esm',
      external: ['./*'],
      metafile: true,
      write: false,
    });
    const imports = Object.values(metafile.inputs).flatMap((input) => input.imports);
    expect(imports).toHaveLength(3);
    // An eager import here loads the server even when a companion mode was selected.
    expect(imports.every((entry) => entry.kind === 'dynamic-import')).toBe(true);
  });

  it.each(['managed-gateway', 'managed-updater'])(
    '%s does not load the HTTP server or session backends',
    async (mode) => {
      const { metafile } = await build({
        entryPoints: [`${sourceRoot}/${mode}-main.ts`],
        bundle: true,
        platform: 'node',
        format: 'esm',
        packages: 'external',
        metafile: true,
        write: false,
      });
      // Follow actual value imports: a constant borrowed from a heavy module can
      // silently restore the entire server graph without changing startup behavior.
      const inputs = Object.keys(metafile.inputs);
      for (const file of ['server-main.ts', 'embedded.ts', 'server.ts', 'mcp-gateway.ts']) {
        expect(inputs).not.toContain(`${sourceRoot}/${file}`);
      }
      if (mode === 'managed-updater') {
        expect(inputs).not.toContain(`${sourceRoot}/self-update/managed-bootstrap.ts`);
      }
      const externalImports = Object.values(metafile.inputs)
        .flatMap((input) => input.imports)
        .filter((entry) => entry.external)
        .map((entry) => entry.path);
      expect(externalImports).not.toContain('@verity/session');
      expect(externalImports).not.toContain('@verity/adapter-claude');
      if (mode === 'managed-gateway') {
        expect(externalImports).not.toContain('@verity/store');
      }
    },
  );
});
