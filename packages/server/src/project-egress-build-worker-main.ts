import { protectedBuildFailure } from './project-egress-build-error.js';
import { runProtectedBuildWorker } from './project-egress-build-worker.js';
const [jobFile, socketPath, keyPath] = process.argv.slice(2);
if (!jobFile || !socketPath || !keyPath)
  throw new Error('Protected build worker requires private control paths');
try {
  process.stdout.write(
    JSON.stringify(await runProtectedBuildWorker({ jobFile, socketPath, keyPath })) + '\n',
  );
} catch (error) {
  // Credentials, response bodies and host paths never become project build output.
  const diagnostic = protectedBuildFailure(error);
  process.stderr.write(
    `Protected build control failed (${diagnostic.reason}${diagnostic.correlationId ? `; reference ${diagnostic.correlationId}` : ''}); remote termination is unconfirmed\n`,
  );
  process.exitCode = 1;
}
