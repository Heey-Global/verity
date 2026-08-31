import type { Readable, Writable } from 'node:stream';

import { createSubprocessSecretJobRunner } from './secret-subprocess-job-runner.js';
import {
  runBootstrappedSecretWorkerProcess,
  type SecretWorkerJobRunner,
} from './secret-worker-process.js';

/** Every restricted pilot image must provide exactly this immutable adapter. */
export const SECRET_JOB_PILOT_PATH = '/usr/local/bin/verity-secret-job-pilot';

export interface SecretWorkerMainOptions {
  input: Readable;
  output: Writable;
  errorOutput: Writable;
  createRunner?: (executablePath: string) => SecretWorkerJobRunner;
}

/** Run the one-job worker. Errors are deliberately reduced to one non-sensitive diagnostic. */
export async function runSecretWorkerMain(options: SecretWorkerMainOptions): Promise<number> {
  const createRunner =
    options.createRunner ??
    ((executablePath: string) => createSubprocessSecretJobRunner({ executablePath }));
  try {
    await runBootstrappedSecretWorkerProcess({
      input: options.input,
      output: options.output,
      runJob: createRunner(SECRET_JOB_PILOT_PATH),
    });
    return 0;
  } catch {
    options.errorOutput.write('verity secret-job worker failed closed\n');
    return 1;
  }
}
