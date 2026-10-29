import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultDevcontainerBuildSpawner } from '../../../packages/server/dist/provisioner.js';
import { BuildStorage } from '../../../packages/server/dist/build-storage.js';
const [, , workspaceFolder, imageName] = process.argv;
let lease;
const samples = [];
try {
  if (process.env.PROBE_STORAGE_ROOT) {
    // This budget belongs only to the small disposable CI fixture, not arbitrary
    // repository Dockerfiles. Production uses its conservative unknown estimate.
    lease = new BuildStorage(process.env.PROBE_STORAGE_ROOT, process.env.PROBE_STORAGE_REPORT, {
      estimateBytes: 4 * 1024 ** 3,
      reserveBytes: 2 * 1024 ** 3,
      reserveInodes: 100_000,
    }).acquire();
    lease.reserveBuild();
    const run = lease.run;
    const sample = (phase) => {
      if (samples.length >= 1000) return;
      try {
        const local = statfsSync(lease.directory);
        const host = JSON.parse(readFileSync(process.env.PROBE_STORAGE_REPORT, 'utf8'));
        samples.push({
          at: new Date().toISOString(),
          phase,
          localAvailableBytes: local.bavail * local.bsize,
          hostObservedAt: host.observedAt,
          roots: host.roots,
        });
      } catch (error) {
        samples.push({
          at: new Date().toISOString(),
          phase,
          state: 'unavailable',
          error: String(error),
        });
      }
    };
    lease.run = async (command, args, options) => {
      const phase =
        command === 'devcontainer'
          ? 'build/export'
          : args[0] === 'load'
            ? 'import'
            : 'builder setup';
      sample(phase);
      const timer = setInterval(() => sample(phase), 2000);
      try {
        return await run(command, args, options);
      } finally {
        clearInterval(timer);
        sample(phase);
      }
    };
  }
  const result = await defaultDevcontainerBuildSpawner({
    workspaceFolder,
    imageName,
    dockerHost: 'unix:///var/run/docker.sock',
    noCache: process.env.PROBE_WARM !== '1',
    ...(lease ? { storageLease: lease } : {}),
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
} catch (error) {
  // The public provisioning error is intentionally bounded. CI needs the
  // captured command output too, so a CLI stack cannot hide the worker failure.
  if (typeof error.cause?.stdout === 'string') process.stdout.write(error.cause.stdout);
  if (typeof error.cause?.stderr === 'string') process.stderr.write(error.cause.stderr);
  process.stderr.write(String(error));
  process.exitCode = 1;
} finally {
  try {
    if (process.env.PROBE_EVIDENCE && samples.length > 0) {
      writeFileSync(
        join(
          process.env.PROBE_EVIDENCE,
          `${imageName.replaceAll(':', '-')}-${process.env.PROBE_WARM === '1' ? 'warm' : 'cold'}-${randomUUID()}-storage.json`,
        ),
        JSON.stringify({ schemaVersion: 1, samples }),
      );
    }
  } finally {
    lease?.dispose();
  }
}
