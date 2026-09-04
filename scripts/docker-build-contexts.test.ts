import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('selective Docker build contexts', () => {
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
