import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';

import { detectDevServers } from './dev-server-detection.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'verity-detect-'));
  roots.push(root);
  return root;
}

describe('detectDevServers', () => {
  it('detects scripts, explicit ports, framework defaults, and the package manager', async () => {
    const root = await repo();
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: '@acme/web-app',
        scripts: { dev: 'vite --port 4100', preview: 'vite preview', storybook: 'storybook dev' },
        devDependencies: { vite: '^7' },
      }),
    );

    expect(await detectDevServers(root)).toEqual([
      expect.objectContaining({
        key: '.:dev',
        name: 'Web App',
        command: 'pnpm run dev',
        containerPort: '4100',
        confidence: 'high',
      }),
      expect.objectContaining({
        key: '.:preview',
        command: 'pnpm run preview',
        containerPort: '4173',
        confidence: 'medium',
      }),
      expect.objectContaining({
        key: '.:storybook',
        command: 'pnpm run storybook',
        containerPort: '6006',
        confidence: 'medium',
      }),
    ]);
  });

  it('detects npm and pnpm workspace packages without following symlinks', async () => {
    const root = await repo();
    await mkdir(join(root, 'apps', 'web'), { recursive: true });
    await mkdir(join(root, 'packages', 'docs'), { recursive: true });
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['apps/*'], scripts: {} }),
    );
    await writeFile(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    await writeFile(
      join(root, 'apps', 'web', 'package.json'),
      JSON.stringify({ name: 'web', scripts: { dev: 'next dev' } }),
    );
    await writeFile(
      join(root, 'packages', 'docs', 'package.json'),
      JSON.stringify({ name: 'docs', scripts: { dev: 'astro dev' } }),
    );
    await symlink(join(root, 'apps', 'web'), join(root, 'apps', 'linked'));

    expect(await detectDevServers(root)).toEqual([
      expect.objectContaining({ workdir: 'apps/web', name: 'Web', containerPort: '3000' }),
      expect.objectContaining({ workdir: 'packages/docs', name: 'Docs', containerPort: '4321' }),
    ]);
  });

  it('falls back to standalone packages when the repo has no root package.json', async () => {
    const root = await repo();
    await mkdir(join(root, 'apps', 'web'), { recursive: true });
    await mkdir(join(root, 'apps', 'admin'), { recursive: true });
    await mkdir(join(root, 'apps', 'web', 'e2e'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'dependency'), { recursive: true });
    await mkdir(join(root, 'services', 'edge', 'nested', 'deep'), { recursive: true });
    await writeFile(
      join(root, 'apps', 'web', 'package.json'),
      JSON.stringify({ name: 'portal', scripts: { dev: 'next dev' } }),
    );
    await writeFile(join(root, 'apps', 'web', 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    await writeFile(
      join(root, 'apps', 'web', 'e2e', 'package.json'),
      JSON.stringify({ name: 'e2e', scripts: { dev: 'vite' } }),
    );
    await writeFile(
      join(root, 'apps', 'admin', 'package.json'),
      JSON.stringify({
        name: 'admin',
        scripts: { dev: `doppler run -c dev -- sh -c 'VITE_API_BASE_URL="$API" vp dev'` },
      }),
    );
    await writeFile(
      join(root, 'services', 'edge', 'nested', 'deep', 'package.json'),
      JSON.stringify({ name: 'too-deep', scripts: { dev: 'vite' } }),
    );
    await writeFile(
      join(root, 'node_modules', 'dependency', 'package.json'),
      JSON.stringify({ name: 'dependency', scripts: { dev: 'vite' } }),
    );

    expect(await detectDevServers(root)).toEqual([
      expect.objectContaining({
        key: 'apps/admin:dev',
        name: 'Admin',
        command: 'npm run dev',
        workdir: 'apps/admin',
        containerPort: '5173',
        confidence: 'medium',
      }),
      expect.objectContaining({
        key: 'apps/web:dev',
        name: 'Portal',
        command: 'pnpm run dev',
        workdir: 'apps/web',
        containerPort: '3000',
        confidence: 'medium',
      }),
    ]);
  });

  it('returns no suggestions for missing, malformed, oversized, or symlinked manifests', async () => {
    const missing = await repo();
    expect(await detectDevServers(missing)).toEqual([]);

    const malformed = await repo();
    await mkdir(join(malformed, 'apps', 'web'), { recursive: true });
    await writeFile(join(malformed, 'package.json'), '{nope');
    await writeFile(
      join(malformed, 'apps', 'web', 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite' } }),
    );
    expect(await detectDevServers(malformed)).toEqual([]);

    const linked = await repo();
    const outside = await repo();
    await writeFile(join(outside, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    await symlink(join(outside, 'package.json'), join(linked, 'package.json'));
    expect(await detectDevServers(linked)).toEqual([]);
  });

  it('keeps unknown scripts as low-confidence suggestions without guessing a port', async () => {
    const root = await repo();
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'api',
        scripts: { serve: 'node server.js' },
        devDependencies: { vite: '^7' },
      }),
    );
    expect(await detectDevServers(root)).toEqual([
      expect.objectContaining({
        name: 'Api serve',
        command: 'npm run serve',
        containerPort: null,
        confidence: 'low',
      }),
    ]);
  });
});
