import { expect, it } from 'vitest';
import { isForgeMergePermissionDenied } from './forge-provider.js';

it.each([
  [403, undefined, true],
  [403, { message: 'API rate limit exceeded' }, false],
  [405, { message: 'Pull Request is not mergeable' }, false],
  [405, { message: 'Not allowed to push into protected branch' }, true],
  [405, { message: 'At least one approving review is required' }, true],
  [409, { message: 'Head SHA changed' }, false],
  [422, { message: 'Validation failed' }, false],
  [500, { message: 'permission denied' }, false],
])('classifies merge refusal %s %j as permission/policy=%s', (status, body, expected) => {
  expect(isForgeMergePermissionDenied(status, body)).toBe(expected);
});
