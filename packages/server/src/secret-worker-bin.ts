#!/nodejs/bin/node

import { runSecretWorkerMain } from './secret-worker-main.js';

process.exitCode = await runSecretWorkerMain({
  input: process.stdin,
  output: process.stdout,
  errorOutput: process.stderr,
});
