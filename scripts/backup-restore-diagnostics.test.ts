import { expect, it } from 'vitest';
// @ts-expect-error -- the standalone Docker fixture imports this JavaScript helper directly.
import { formatRestoreFailure } from '../.github/scripts/backup-restore-diagnostics.mjs';

it('reports only approved error codes and compiled code positions, never recovery input', () => {
  const secret = 'private-recovery-master-password';
  const error = Object.assign(new Error(secret), {
    code: secret,
    cause: new Error(secret),
    stdout: secret,
    stderr: secret,
    stack: `Error: ${secret}\n    at verify (/app/packages/server/dist/backup/restore-staging.js:42:8)\n    at ${secret} (/private/${secret}:1:1)`,
  });
  expect(formatRestoreFailure(error)).toBe(
    'Restore fixture failure: ' +
      JSON.stringify({
        code: 'unknown',
        sites: ['/app/packages/server/dist/backup/restore-staging.js:42:8'],
      }),
  );
  expect(formatRestoreFailure(Object.assign(error, { code: 'ENOSPC' }))).toContain('ENOSPC');
  expect(formatRestoreFailure(undefined)).not.toContain(secret);
});
