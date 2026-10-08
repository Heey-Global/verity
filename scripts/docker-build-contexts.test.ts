import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('selective Docker build contexts', () => {
  it('ships the browser export at the configured server path', () => {
    const dockerfile = readFileSync('deploy/Dockerfile', 'utf8');
    const webStage = dockerfile.split('FROM builder-deps AS web-builder\n')[1]?.split('FROM ')[0];
    expect(webStage).toBeDefined();
    for (const source of ['apps/mobile', 'packages/mobile', 'packages/events'])
      expect(webStage).toContain(`COPY ${source} ${source}`);
    const manifest = JSON.parse(readFileSync('apps/mobile/package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    const exportScript = Object.entries(manifest.scripts).find(([, command]) =>
      command.includes('expo export --platform web'),
    )?.[0];
    expect(exportScript).toBeDefined();
    expect(webStage).toContain(`npm run ${exportScript} --workspace @verity/mobile-app`);
    const runtime = dockerfile.split(' AS runtime\n')[1]!;
    const directory = runtime.match(/^ENV VERITY_WEB_APP_DIR=(\S+)$/mu)?.[1];
    expect(directory).toBeDefined();
    // Exporting successfully is insufficient if the runtime never receives the assets.
    expect(runtime).toContain(
      `COPY --from=web-builder --chown=node:node /app/apps/mobile/dist .${directory!.slice('/app'.length)}`,
    );
  });

  it('ships production dependencies nested below workspace packages', () => {
    for (const dockerfilePath of ['deploy/Dockerfile', 'deploy/secret-job-worker.Dockerfile']) {
      const dockerfile = readFileSync(dockerfilePath, 'utf8');

      // npm can move a runtime dependency out of the root tree when two
      // workspaces require incompatible versions. Copying only /app/node_modules
      // then builds successfully but leaves the shipped image unable to start.
      expect(dockerfile).toMatch(
        /COPY --from=deps[^\n]* \/app\/node_modules \.\/node_modules\n(?:#[^\n]*\n)*COPY --from=deps[^\n]* \/app\/packages \.\/packages/,
      );
    }
  });

  it('ships compiled output for the server workspace dependency closure', () => {
    const packages = new Map(
      readdirSync('packages').map((directory) => {
        const manifest = JSON.parse(readFileSync(`packages/${directory}/package.json`, 'utf8')) as {
          name: string;
          dependencies?: Record<string, string>;
        };
        return [manifest.name, { directory, manifest }] as const;
      }),
    );
    const dockerfile = readFileSync('deploy/Dockerfile', 'utf8');
    const visited = new Set<string>();
    const visit = (name: string) => {
      if (visited.has(name)) return;
      visited.add(name);
      const workspace = packages.get(name);
      if (!workspace) return;
      // A successful builder can hide missing workspace output in the final image.
      expect(dockerfile, `missing runtime output for ${name}`).toMatch(
        new RegExp(
          `COPY --from=builder[^\\n]* /app/packages/${workspace.directory}/dist \\./packages/${workspace.directory}/dist`,
        ),
      );
      for (const dependency of Object.keys(workspace.manifest.dependencies ?? {}))
        visit(dependency);
    };
    visit('@verity/server');
  });

  it('includes every root TypeScript project in builders that run the root build', () => {
    const rootConfig = JSON.parse(readFileSync('tsconfig.json', 'utf8')) as {
      references: Array<{ path: string }>;
    };

    for (const dockerfilePath of ['deploy/Dockerfile', 'deploy/secret-job-worker.Dockerfile']) {
      const dockerfile = readFileSync(dockerfilePath, 'utf8');
      for (const { path } of rootConfig.references) {
        if (!path.startsWith('packages/')) continue;
        expect(dockerfile, `missing ${path} from ${dockerfilePath} builder`).toContain(
          `COPY ${path} ${path}`,
        );
      }
    }
  });

  it('preserves the preview package ESM contract in both runtime images', () => {
    const previewPackage = JSON.parse(
      readFileSync('packages/preview-tunnel/package.json', 'utf8'),
    ) as { dependencies: { ws: string } };
    const lockfile = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
      packages: Record<string, { version?: string }>;
    };

    expect(lockfile.packages['node_modules/ws']?.version).toBe(previewPackage.dependencies.ws);
    expect(lockfile.packages['packages/preview-tunnel/node_modules/ws']).toBeUndefined();

    for (const dockerfilePath of [
      'deploy/preview-edge.Dockerfile',
      'deploy/preview-connector.Dockerfile',
    ]) {
      const dockerfile = readFileSync(dockerfilePath, 'utf8');
      expect(dockerfile, `missing runtime package.json from ${dockerfilePath}`).toContain(
        'COPY --from=build /src/packages/preview-tunnel/package.json ./package.json',
      );
      expect(dockerfile, `must copy the hoisted ws install in ${dockerfilePath}`).toContain(
        'COPY --from=build /src/node_modules/ws ./node_modules/ws',
      );
      expect(dockerfile).not.toContain('/src/packages/preview-tunnel/node_modules/ws');
    }
  });

  it('packages a PNG logo into the public preview edge', () => {
    const dockerfile = readFileSync('deploy/preview-edge.Dockerfile', 'utf8');
    const asset = dockerfile.match(
      /^COPY (packages\/preview-tunnel\/assets\/\S+) \.\/assets\/verity-mark\.png$/mu,
    )?.[1];
    expect(asset).toBeDefined();
    expect([...readFileSync(asset!).subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it('installs and probes the shared libraries required by copied Python', () => {
    const dockerfile = readFileSync('deploy/verity-sandbox.Dockerfile', 'utf8');
    for (const dependency of ['libbz2-1.0', 'libexpat1', 'libffi8', 'libsqlite3-0', 'libssl3']) {
      expect(dockerfile).toContain(dependency);
    }
    expect(dockerfile).toContain('import bz2, ctypes, lzma, readline, sqlite3, ssl, tkinter, uuid');
  });

  it('selects verified Docker CLI artifacts for both published architectures', () => {
    const dockerfile = readFileSync('deploy/Dockerfile', 'utf8');
    expect(dockerfile).toContain('ARG TARGETARCH');
    expect(dockerfile).toContain('amd64) docker_arch=x86_64');
    expect(dockerfile).toContain('arm64) docker_arch=aarch64');
    expect(dockerfile).toContain('DOCKER_CLI_SHA256_ARM64=');
    expect(dockerfile).toContain('DOCKER_BUILDX_SHA256_ARM64=');
    expect(dockerfile).toContain('DOCKER_COMPOSE_SHA256_ARM64=');
  });

  it('lets Node size the project relay heap from its container limit', () => {
    const dockerfile = readFileSync('deploy/project-relay.Dockerfile', 'utf8');
    expect(dockerfile).toContain('ENTRYPOINT ["/nodejs/bin/node", "/app/dist/main.js"]');
    expect(dockerfile).not.toContain('--max-old-space-size');
  });

  it('excludes nested environment variants from every Docker build context', () => {
    const dockerignore = readFileSync('.dockerignore', 'utf8');
    expect(dockerignore).toMatch(/^\.env\.\*$/mu);
    expect(dockerignore).toMatch(/^\*\*\/\.env\.\*$/mu);
  });
});
