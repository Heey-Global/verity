import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { BuildStorage } from './build-storage.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'unmanaged-capacity-'));
  roots.push(directory);
  const root = join(directory, 'storage');
  const gate = join(directory, 'gate');
  const report = join(directory, 'report.json');
  const hostBootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  writeFileSync(
    report,
    JSON.stringify({
      schemaVersion: 1,
      hostBootId,
      hostIdentity: 'a'.repeat(64),
      observedAt: new Date().toISOString(),
      roots: ['buildkit', 'docker', 'containerd', 'export', 'project'].map((kind) => ({
        kind,
        state: 'available',
        availableBytes: 1024 ** 4,
        freeInodes: 10_000_000,
      })),
    }),
  );
  const make = () =>
    new BuildStorage(
      root,
      report,
      { estimateBytes: 100, reserveBytes: 0, reserveInodes: 0 },
      () => ({ availableBytes: 1024 ** 4, freeInodes: 10_000_000 }),
      gate,
    );
  return { root, gate, directory, make };
}
const options = { env: process.env, timeout: 5000, maxBuffer: 4096 };

it.each([false, true])(
  'keeps timed-out legacy remote work excluded after disposal and manager restart (transition=%s)',
  async (transition) => {
    const f = fixture();
    const manager = f.make();
    const lease = manager.admit();
    if (transition) {
      mkdirSync(join(f.gate, 'leases'), { recursive: true });
      writeFileSync(join(f.gate, 'build-admission.lock'), '');
    }
    await expect(
      lease.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        ...options,
        timeout: 100,
        remoteOperation: 'build-export',
      }),
    ).rejects.toThrow();
    lease.dispose();
    expect(lease.retainArtifacts).toBe(true);
    expect(() => manager.checkDependencyCapacity(1, 1)).toThrow(/unmanaged build/);
    const restarted = f.make();
    expect(() => restarted.checkDependencyCapacity(1, 1)).toThrow(/unmanaged build/);
    await restarted.reconcile({ buildkitIdle: async () => false });
    expect(() => restarted.checkDependencyCapacity(1, 1)).toThrow(/unmanaged build/);
    await restarted.reconcile({ buildkitIdle: async () => true });
    expect(() => restarted.checkDependencyCapacity(1, 1)).not.toThrow();
    expect(readdirSync(f.root)).toEqual([]);
  },
);

it('releases a completed legacy command without leaving admission pressure', async () => {
  const f = fixture();
  const manager = f.make();
  const lease = manager.admit();
  await lease.run(process.execPath, ['-e', ''], options);
  lease.dispose();
  expect(readdirSync(f.root)).toEqual([]);
  expect(() => manager.checkDependencyCapacity(1, 1)).not.toThrow();
});

it('tracks surviving earlier command groups across subsequent commands and disposal', async () => {
  const f = fixture();
  const manager = f.make();
  const lease = manager.admit();
  const pidfile = join(f.directory, 'child');
  let group: number | undefined;
  try {
    await lease.run(
      process.execPath,
      [
        '-e',
        `const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidfile)},String(child.pid));child.unref();`,
      ],
      options,
    );
    expect(existsSync(pidfile)).toBe(true);
    const journal = join(f.root, readdirSync(f.root)[0]!);
    group = Number(readFileSync(join(journal, 'child-0'), 'utf8'));
    await lease.run(process.execPath, ['-e', ''], options);
    lease.dispose();
    expect(() => manager.checkDependencyCapacity(1, 1)).toThrow(/unmanaged build/);
    process.kill(-group, 'SIGKILL');
    group = undefined;
  } finally {
    if (group) {
      try {
        process.kill(-group, 'SIGKILL');
      } catch {
        /* already exited */
      }
    }
    lease.dispose();
  }
});
