import { expect, it } from 'vitest';
import {
  formatRestoreFailure,
  formatRestoreLog,
} from '../.github/scripts/backup-restore-diagnostics.mjs';

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

it('redacts private activation logs while preserving static readiness failures and code locations', () => {
  const secret = 'private-key-password-and-device-token';
  const log = [
    secret,
    'verity-compose: managed topology failed readiness; restoring the legacy Server',
    JSON.stringify({
      err: {
        message: secret,
        code: '23505',
        stack: `Error: ${secret}\n at run (/app/packages/server/dist/embedded.js:77:2)`,
      },
    }),
  ].join('\n');
  const result = formatRestoreLog(log);
  expect(result).not.toContain(secret);
  expect(result).toContain('managed topology failed readiness');
  expect(result).toContain('/app/packages/server/dist/embedded.js:77:2');
  expect(result).toContain('23505');
  expect(formatRestoreLog(secret)).not.toContain(secret);
});
