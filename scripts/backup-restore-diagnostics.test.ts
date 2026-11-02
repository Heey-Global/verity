import { expect, it } from 'vitest';
import { DockerError } from '../packages/server/src/docker.js';
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
  const filesystemFailure = formatRestoreLog(
    `Error: ${secret} { code: 'ENOENT', path: '${secret}' }`,
  );
  expect(filesystemFailure).toContain('ENOENT');
  expect(filesystemFailure).not.toContain(secret);
});

it('locates fixture assertions and reports numeric statuses without private compared values', () => {
  const error = {
    code: 'ERR_ASSERTION',
    stack: 'Error\n at restore (file:///opt/verity-restore-fixture/driver.mjs:638:14)',
    actual: 503,
    expected: 200,
  };
  const result = formatRestoreFailure(error);
  expect(result).toContain('/opt/verity-restore-fixture/driver.mjs:638:14');
  expect(result).toContain('"actual":503');
  expect(result).toContain('"expected":200');
  expect(
    formatRestoreFailure({ ...error, actual: 'private-token', expected: 'private-key' }),
  ).not.toContain('private-');
});

it('preserves Docker failure categories without exposing daemon messages or identifiers', () => {
  const secret = 'private-container-and-recovery-token';
  for (const payload of [
    { kind: 'other' as const, status: 500, message: secret },
    { kind: 'conflict' as const, message: secret },
    { kind: 'container_not_found' as const, id: secret },
    { kind: 'network' as const, cause: new Error(secret) },
  ]) {
    const result = formatRestoreFailure(new DockerError(payload));
    expect(result).toContain(`"dockerKind":"${payload.kind}"`);
    expect(result).not.toContain(secret);
    if (payload.kind === 'other') expect(result).toContain('"dockerStatus":500');
    else expect(result).not.toContain('dockerStatus');
  }
  expect(formatRestoreFailure({ name: 'DockerError', kind: secret, status: secret })).not.toContain(
    secret,
  );
  for (const status of [NaN, Infinity, 500.5, 399, 600, '500']) {
    expect(formatRestoreFailure({ name: 'DockerError', kind: 'other', status })).not.toContain(
      'dockerStatus',
    );
  }
  expect(formatRestoreFailure({ name: 'Error', kind: 'conflict', status: 500 })).not.toContain(
    'dockerKind',
  );
});
