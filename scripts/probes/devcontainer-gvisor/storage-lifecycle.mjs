// Destructive cache operations are confined to the disposable CI worker.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { randomFillSync } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statfsSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BuildStorage } from '../../../packages/server/dist/build-storage.js';
import { cacheBytes, parseCacheUsage } from './storage-evidence.mjs';

const { AbortController, AbortSignal } = globalThis;

assert.equal(process.env.GITHUB_ACTIONS, 'true');
const [workspace, image] = process.argv.slice(2);
assert(workspace && image?.startsWith('verity-host-builder-'));
const evidence = process.env.PROBE_EVIDENCE;
assert(evidence && process.env.PROBE_STORAGE_REPORT && process.env.PROBE_STORAGE_ROOT);
const GiB = 1024 ** 3;
const client = '/usr/local/libexec/verity-buildkit/buildctl';
const address = ['--addr', 'unix:///run/verity-buildkit/buildkitd.sock'];
const context = join(workspace, 'storage-lifecycle');
mkdirSync(context);
const sentinel = join(context, 'project-data');
writeFileSync(sentinel, 'preserve project data');
const env = { PATH: process.env.PATH, HOME: context, DOCKER_CONFIG: context };
const lease = new BuildStorage(process.env.PROBE_STORAGE_ROOT, process.env.PROBE_STORAGE_REPORT, {
  estimateBytes: 4 * GiB,
  reserveBytes: 2 * GiB,
  reserveInodes: 100_000,
}).acquire();
const abort = new AbortController();
const disk = () => {
  const value = statfsSync(context);
  return value.bavail * value.bsize;
};
const baseline = disk();
const observations = [];
const guard = () => {
  const available = disk();
  observations.push({ at: new Date().toISOString(), availableBytes: available });
  if (available < 2 * GiB || baseline - available > 4 * GiB) {
    abort.abort(new Error('CI lifecycle fixture exceeded its disk budget'));
  }
  assert.equal(abort.signal.aborted, false, 'CI lifecycle resource/time budget exhausted');
};
const deadline = setTimeout(() => abort.abort(), 6 * 60_000);
// The monitor records pressure; command cancellation is handled by the lease.
const monitor = setInterval(() => {
  try {
    guard();
  } catch {
    abort.abort();
  }
}, 1000);
const options = { env, signal: abort.signal, timeout: 90_000, maxBuffer: 4 * 1024 ** 2 };
const run = (...args) => {
  guard();
  return lease.run(client, [...address, ...args], options);
};
const inspect = (...args) =>
  execFileSync(client, [...address, ...args], {
    env,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 4 * 1024 ** 2,
  });
const usage = () => parseCacheUsage(inspect('du', '--format', '{{json .}}'));
const histories = () =>
  inspect('debug', 'histories', '--format', '{{json .}}')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).record);
const waitFor = async (check, message) => {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    guard();
    const result = check();
    if (result) return result;
    await delay(250);
  }
  throw new Error(message);
};
const build = () => [
  'build',
  '--frontend',
  'dockerfile.v0',
  '--local',
  `context=${context}`,
  '--local',
  `dockerfile=${context}`,
  '--no-cache',
  '--progress',
  'plain',
];
let result;
try {
  lease.reserveBuild();
  // No export or import is used for cache pressure: ten independent 128 MiB
  // COPY results stay within the 4 GiB combined context/cache growth allowance.
  writeFileSync(join(context, 'Dockerfile'), 'FROM scratch\nCOPY payload /payload\n');
  writeFileSync(join(context, '.dockerignore'), '*\n!payload\n!Dockerfile\n');
  const chunk = Buffer.alloc(1024 ** 2);
  for (let attempt = 0; attempt < 10; attempt++) {
    guard();
    const file = openSync(join(context, 'payload'), 'w');
    try {
      for (let part = 0; part < 128; part++) writeSync(file, randomFillSync(chunk));
    } finally {
      closeSync(file);
    }
    await run(...build());
  }
  const before = usage();
  result = { before };
  assert(cacheBytes(before) > GiB, 'Fixture must exceed the target cache budget');

  // Hold a real solve while applying the same BuildKit budget mechanism used
  // by GC. This exercises reference safety; automatic GC scheduling is separate.
  const config = JSON.parse(readFileSync(join(workspace, '.devcontainer/devcontainer.json')));
  const base = config.build.args.PROBE_BASE_IMAGE;
  assert(/^node:[^\s]+@sha256:[a-f0-9]{64}$/.test(base));
  writeFileSync(join(context, 'Dockerfile'), `FROM ${base}\nRUN sleep 120\n`);
  const prior = new Set(histories().map((record) => record.Ref));
  const cancel = new AbortController();
  const pending = lease.run(client, [...address, ...build()], {
    ...options,
    signal: AbortSignal.any([abort.signal, cancel.signal]),
  });
  // Observe rejection immediately to avoid an unhandled abort during inspection.
  const settled = pending.then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error: String(error) }),
  );
  try {
    const active = await waitFor(
      () => histories().find((record) => !prior.has(record.Ref) && !record.CompletedAt),
      'No active remote solve observed',
    );
    await waitFor(
      () => usage().some((record) => record.inUse && record.description.includes('sleep 120')),
      'The remote RUN step did not become active',
    );
    const pinned = usage()
      .filter((record) => record.inUse && record.description.includes('sleep 120'))
      .map((record) => record.id);
    assert(pinned.length > 0, 'The active RUN must hold a cache reference');
    // Prune cannot use the already-running lease command slot. This separate
    // bounded client acts only on this disposable worker, never project images.
    const pruned = inspect('prune', '--all', '--keep-storage', String(GiB / 1e6));
    writeFileSync(join(evidence, 'cache-prune.log'), pruned);
    const after = usage();
    result = { before, after, pinned };
    const kept = new Set(after.map((record) => record.id));
    assert(
      pinned.every((id) => kept.has(id)),
      'GC removed an active reference',
    );
    assert(cacheBytes(after) < cacheBytes(before), 'Eligible cache did not converge');
    const reclaimable = after.filter((record) => !record.inUse);
    assert(cacheBytes(reclaimable) <= GiB, 'Reclaimable cache remains above target');
    cancel.abort();
    assert.equal((await settled).ok, false, 'Cancelled client unexpectedly succeeded');
    const completed = await waitFor(
      () => histories().find((record) => record.Ref === active.Ref && record.CompletedAt),
      'Remote BuildKit solve remained active after client cancellation',
    );
    assert(completed.error, 'Cancelled remote solve must record an error');
    result = { before, after, pinned, cancelledSolve: completed };
  } finally {
    cancel.abort();
    await settled;
  }
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserve project data');
  execFileSync('docker', ['image', 'inspect', image], { timeout: 10_000, stdio: 'ignore' });
  console.log(
    'PASS: cache converges under budget, active refs/image/data survive, remote solve cancels',
  );
} finally {
  clearTimeout(deadline);
  clearInterval(monitor);
  lease.dispose();
  assert.deepEqual(readdirSync(process.env.PROBE_STORAGE_ROOT), []);
  writeFileSync(
    join(evidence, 'storage-lifecycle.json'),
    JSON.stringify({ schemaVersion: 1, result, observations }),
  );
}
