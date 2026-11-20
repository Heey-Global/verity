import { expect, it } from 'vitest';
import { DockerError } from './docker.js';
import { localTargetConfirmedMissing } from './local-preview-activity.js';
import { PreviewShareConflictError } from './preview-network-policy.js';

it('recognizes typed Docker absence without mistaking daemon faults for absence', () => {
  expect(
    localTargetConfirmedMissing(new DockerError({ kind: 'container_not_found', id: 'gone' })),
  ).toBe(true);
  expect(
    localTargetConfirmedMissing(
      new DockerError({ kind: 'network', cause: new Error('socket closed') }),
    ),
  ).toBe(false);
  expect(
    localTargetConfirmedMissing(
      new DockerError({ kind: 'other', status: 500, message: 'daemon unavailable' }),
    ),
  ).toBe(false);
  expect(localTargetConfirmedMissing(new Error('container_not_found'))).toBe(false);
});

it.each([
  'static publish directory does not exist or is not a safe directory',
  'project checkout does not exist',
  'session worktree does not exist',
  'session worktree is outside the project checkout',
])('classifies concrete filesystem evidence through %s wrappers', (message) => {
  for (const code of ['ENOENT', 'ENOTDIR']) {
    const cause = new Error('filesystem target missing', {
      cause: Object.assign(new Error('lookup'), { code }),
    });
    expect(localTargetConfirmedMissing(new PreviewShareConflictError(message, { cause }))).toBe(
      true,
    );
  }
  for (const code of ['EACCES', 'EIO', 'ECONNRESET']) {
    const cause = new Error('filesystem probe failed', {
      cause: Object.assign(new Error('lookup'), { code }),
    });
    expect(localTargetConfirmedMissing(new PreviewShareConflictError(message, { cause }))).toBe(
      false,
    );
  }
  for (const reason of ['unsafe static directory', 'static path contains a symlink']) {
    expect(
      localTargetConfirmedMissing(
        new PreviewShareConflictError(message, {
          cause: new Error('validation', { cause: new Error(reason) }),
        }),
      ),
    ).toBe(true);
  }
  expect(localTargetConfirmedMissing(new PreviewShareConflictError(message))).toBe(false);
});

it('does not infer absence from unrecognized or circular errors', () => {
  const cyclic = new Error('unknown', { cause: undefined });
  cyclic.cause = cyclic;
  expect(
    localTargetConfirmedMissing(
      new PreviewShareConflictError('session worktree does not exist', { cause: cyclic }),
    ),
  ).toBe(false);
  expect(localTargetConfirmedMissing(new Error('unsafe static directory'))).toBe(false);
  expect(
    localTargetConfirmedMissing(
      new PreviewShareConflictError('different conflict', {
        cause: Object.assign(new Error('lookup'), { code: 'ENOENT' }),
      }),
    ),
  ).toBe(false);
});
