import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  lstatSync,
  readFileSync,
  openSync,
  fstatSync,
  closeSync,
  constants,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { DevcontainerBuildSpawner } from './provisioner.js';
import { protectedBuildRequest } from './project-egress-build.js';
import { createProtectedBuildClient } from './project-egress-build-client.js';

/** Reuses normal audit, snapshot and storage admission; only the build executor changes.
 * Importing a completed archive is local Engine work and cannot fetch dependencies.
 */
export function createProtectedDevcontainerBuilder(options: {
  root: string;
  socketPath: string;
  keyPath: string;
  workerFile?: string;
}): DevcontainerBuildSpawner {
  return async (args) => {
    if (!args.projectId || !args.storageLease)
      throw new Error('Protected builds require project identity and managed build storage');
    // Readiness failure must not register remote work or strand its reservation.
    const key = readFileSync(options.keyPath, 'utf8').trim();
    const health = await createProtectedBuildClient({
      socketPath: options.socketPath,
      token: () => key,
    })({ operation: 'health' });
    if (!('available' in health) || !health.available)
      throw new Error('Protected builder is not ready');
    const lease = args.storageLease;
    const root = resolve(options.root);
    const snapshot = relative(root, realpathSync(args.workspaceFolder)).split('\\').join('/');
    const request = protectedBuildRequest.parse({
      projectId: args.projectId,
      attemptId: randomUUID(),
      snapshot,
      image: args.imageName,
      noCache: args.noCache === true,
    });
    if (dirname(realpathSync(args.workspaceFolder)) !== realpathSync(lease.directory))
      throw new Error('Protected build snapshot is outside its storage lease');
    const directory = join(lease.directory, 'protected-build');
    mkdirSync(directory, { mode: 0o700 });
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
      throw new Error('Invalid protected build staging directory');
    const job = join(directory, 'job.json');
    writeFileSync(job, JSON.stringify({ request }), { mode: 0o600, flag: 'wx' });
    // Private input consumed only by the fixed host supervisor; never part of the clone.
    writeFileSync(
      join(directory, 'inputs.json'),
      JSON.stringify({ additionalFeatures: args.additionalFeatures }),
      { mode: 0o600, flag: 'wx' },
    );
    if (args.registryToken)
      writeFileSync(
        join(directory, 'registry.json'),
        JSON.stringify({
          auths: {
            'ghcr.io': {
              auth: Buffer.from(`x-access-token:${args.registryToken}`).toString('base64'),
            },
          },
        }),
        { mode: 0o600, flag: 'wx' },
      );
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
    try {
      const result = await lease.run(
        process.execPath,
        [
          options.workerFile ??
            fileURLToPath(new URL('./project-egress-build-worker-main.js', import.meta.url)),
          job,
          options.socketPath,
          options.keyPath,
        ],
        {
          env,
          remoteOperation: 'protected-build',
          timeout: 32 * 60_000,
          maxBuffer: 64 * 1024,
          ...(args.signal ? { signal: args.signal } : {}),
        },
      );
      const outcome = z.strictObject({ success: z.boolean() }).parse(JSON.parse(result.stdout));
      if (!outcome.success) {
        const failure = new Error(
          'Protected devcontainer build failed; retry after checking its build diagnostics',
        );
        let fd: number | undefined;
        try {
          fd = openSync(
            join(directory, 'build.log'),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          const info = fstatSync(fd);
          if (info.isFile() && info.nlink === 1 && info.size <= 262144 && (info.mode & 0o077) === 0)
            Object.assign(failure, { stderr: readFileSync(fd, 'utf8') });
        } catch {
          /* A missing diagnostic never changes the host's failure verdict. */
        } finally {
          if (fd !== undefined) closeSync(fd);
        }
        throw failure;
      }
      await lease.run('docker', ['load', '--input', join(directory, 'image.tar')], {
        env: { PATH: process.env.PATH, DOCKER_HOST: args.dockerHost },
        remoteOperation: 'image-import',
        timeout: 15 * 60_000,
        maxBuffer: 1024 * 1024,
        ...(args.signal ? { signal: args.signal } : {}),
      });
      return { stdout: 'Protected devcontainer image built and imported', stderr: '' };
    } finally {
      if (!lease.retainArtifacts) {
        rmSync(join(directory, 'registry.json'), { force: true });
        rmSync(join(directory, 'inputs.json'), { force: true });
      }
    }
  };
}
