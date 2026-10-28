// Isolated disposable workers only; never connect this probe to a host worker.
import assert from 'node:assert/strict';
import { parseCacheUsage, cacheBytes } from './storage-evidence.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, statfsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.getuid(), 0);
const root = process.argv[2];
assert(root?.startsWith(`${process.env.RUNNER_TEMP}/verity-storage-comparison.`));
const evidence = process.env.PROBE_EVIDENCE;
assert(evidence);
const bin = '/usr/local/libexec/verity-buildkit/';
const GiB = 1024 ** 3;
const baseline = statfsSync(root);
const free = (s) => s.bavail * s.bsize;
const started = Date.now();
const results = [];
let worker;
let command;
let failure;
const guard = () => {
  const s = statfsSync(root);
  assert(free(s) >= 2 * GiB && s.ffree >= 100_000, 'Filesystem reserve exhausted');
  assert(free(baseline) - free(s) <= 4 * GiB, 'Filesystem growth exceeded 4 GiB');
  assert(Date.now() - started < 360_000, 'Comparison exceeded six minutes');
};
const kill = (child) => {
  if (child?.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
};
const monitor = setInterval(() => {
  try {
    guard();
  } catch (error) {
    failure = error;
    kill(command);
    kill(worker);
  }
}, 250);
const run = (file, args, timeout = 15_000) =>
  new Promise((resolve, reject) => {
    guard();
    const child = spawn(file, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    command = child;
    let output = '';
    const collect = (chunk) => {
      output += chunk;
      if (output.length > 1024 ** 2) kill(child);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => kill(child), timeout);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      command = undefined;
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${file} exited ${code}: ${output.slice(-4000)}`));
      else resolve(output);
    });
  });
const stop = async () => {
  if (!worker) return;
  const child = worker;
  const closed =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once('close', resolve));
  kill(child);
  await closed;
  worker = undefined;
};
try {
  for (const snapshotter of ['native', 'overlayfs']) {
    guard();
    const caseStart = Date.now();
    const caseTimer = setTimeout(() => {
      failure = new Error(`${snapshotter} exceeded 120 seconds`);
      kill(command);
      kill(worker);
    }, 120_000);
    const dir = join(root, snapshotter);
    mkdirSync(dir);
    const context = join(dir, 'context');
    mkdirSync(context);
    writeFileSync(join(context, 'base'), randomBytes(32 * 1024 ** 2));
    for (let i = 0; i < 6; i++) writeFileSync(join(context, `small${i}`), `step ${i}`);
    writeFileSync(
      join(context, 'Dockerfile'),
      'FROM scratch\nCOPY base /base\n' +
        Array.from({ length: 6 }, (_, i) => `COPY small${i} /small${i}\n`).join(''),
    );
    const socket = `unix://${dir}/buildkit.sock`;
    const ctl = (...args) => run(`${bin}buildctl`, ['--addr', socket, ...args]);
    const start = async (gc) => {
      const config = join(dir, 'buildkitd.toml');
      writeFileSync(
        config,
        `[worker.oci]\n  enabled = true\n  snapshotter = "${snapshotter}"\n  gc = ${gc}\n[worker.containerd]\n  enabled = false\n` +
          (gc
            ? '[[worker.oci.gcpolicy]]\n' +
              '  all = true\n  reservedSpace = 0\n  maxUsedSpace = "16MB"\n  minFreeSpace = 0\n'
            : ''),
      );
      worker = spawn(
        `${bin}buildkitd`,
        ['--config', config, '--root', join(dir, 'state'), '--addr', socket],
        { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let log = '';
      const collect = (chunk) => {
        log = (log + chunk).slice(-128_000);
      };
      worker.stdout.on('data', collect);
      worker.stderr.on('data', collect);
      worker.on('error', (error) => {
        failure = error;
      });
      for (let i = 0; i < 40; i++) {
        if (worker.exitCode !== null) throw new Error(log);
        try {
          await ctl('debug', 'workers');
          return;
        } catch {
          await delay(250);
        }
      }
      throw new Error(`Worker did not start: ${log}`);
    };
    try {
      await start(false);
      const build = () =>
        ctl(
          'build',
          '--frontend',
          'dockerfile.v0',
          '--local',
          `context=${context}`,
          '--local',
          `dockerfile=${context}`,
          '--progress',
          'plain',
        );
      await build();
      const stateBytes = Number(
        execFileSync('du', ['-sx', '--block-size=1', join(dir, 'state')], {
          encoding: 'utf8',
          timeout: 5000,
        }).split(/\s/)[0],
      );
      const before = await ctl('du', '--format', '{{json .}}');
      await stop();
      await start(true);
      // A completed solve schedules daemon GC. No explicit prune is used.
      await build();
      let after;
      const deadline = Date.now() + 80_000;
      do {
        await delay(1000);
        guard();
        after = await ctl('du', '--format', '{{json .}}');
        if (cacheBytes(parseCacheUsage(after).filter((record) => !record.inUse)) <= 16 * 1024 ** 2)
          break;
      } while (Date.now() < deadline);
      assert(
        cacheBytes(parseCacheUsage(after)) < cacheBytes(parseCacheUsage(before)),
        'Automatic GC did not remove eligible records',
      );
      assert(
        cacheBytes(parseCacheUsage(after).filter((record) => !record.inUse)) <= 16 * 1024 ** 2,
        'Automatic GC did not converge to the eligible-cache target',
      );
      results.push({ snapshotter, stateBytes, before, after, elapsedMs: Date.now() - caseStart });
    } finally {
      clearTimeout(caseTimer);
      await stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  assert(
    results[0].stateBytes > results[1].stateBytes,
    'Native COPY amplification was not observed',
  );
} finally {
  clearInterval(monitor);
  kill(command);
  await stop();
  writeFileSync(
    join(evidence, 'storage-comparison.json'),
    JSON.stringify({ results, error: String(failure ?? '') }, null, 2),
  );
}
