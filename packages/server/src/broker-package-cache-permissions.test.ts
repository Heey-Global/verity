import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  acquirePackageCacheLease,
  type AgentSpawnBrokerOptions,
} from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';

// Production permits the broker to hand ownership to the agent, but denies
// changing that agent-owned directory's mode without CAP_FOWNER.
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    chmod: vi.fn(async (...args: Parameters<typeof fs.chmod>) => {
      if (String(args[0]).endsWith('/package-cache/npm'))
        throw Object.assign(new Error('Cache mode change is not permitted'), { code: 'EPERM' });
      return fs.chmod(...args);
    }),
  };
});
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(): Promise<AgentSpawnBrokerOptions> {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'cache-permissions-'));
  roots.push(runtimeDir);
  return {
    runtimeDir,
    enforceRoot: false,
    agentUid: process.getuid!(),
    agentGid: process.getgid!(),
  };
}
it('creates and reuses the private cache without chmod on the agent-owned path', async () => {
  const options = await fixture();
  const first = await acquirePackageCacheLease(options);
  await first.close();
  const concurrent = await Promise.all([
    acquirePackageCacheLease(options),
    acquirePackageCacheLease(options),
  ]);
  try {
    await expect(acquirePackageCacheLease(options, true)).rejects.toThrow(
      'package cache is in use',
    );
  } finally {
    await Promise.all(concurrent.map((lease) => lease.close()));
  }
  await (await acquirePackageCacheLease(options, true)).close();
});
it('retains an existing cache with unsafe permissions instead of trying to repair it', async () => {
  const options = await fixture();
  await mkdir(join(options.runtimeDir!, 'package-cache', 'npm'), { recursive: true, mode: 0o755 });
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  await fs.chmod(join(options.runtimeDir!, 'package-cache', 'npm'), 0o755);
  await expect(acquirePackageCacheLease(options)).rejects.toThrow('invalid package cache');
});

it('runs bounded cache maintenance as a separate owner process and retains other cache data', async () => {
  const options = await fixture();
  const parent = join(options.runtimeDir!, 'cache');
  await mkdir(join(parent, '_cacache'), { recursive: true });
  await mkdir(join(parent, '_npx'));
  await writeFile(join(parent, '_cacache', 'payload'), 'cache');
  const allocated =
    (await stat(join(parent, '_cacache'))).blocks * 512 +
    (await stat(join(parent, '_cacache', 'payload'))).blocks * 512;
  const child = spawnSync(
    process.execPath,
    ['features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs', '--package-cache-leaf'],
    {
      input: JSON.stringify({
        parent,
        maxBytes: 0,
        shared: true,
        remainingEntries: 1000,
        durationMs: 5000,
      }),
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toMatchObject({
    removedBytes: allocated,
    remainingBytes: 0,
    pruned: true,
    otherEntries: true,
  });
  expect(existsSync(join(parent, '_cacache'))).toBe(false);
  expect(existsSync(join(parent, '_npx'))).toBe(true);
});
