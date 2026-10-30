import { expect, it } from 'vitest';
import { stripTrailingSlashes } from './path-text.js';

it.each([
  ['', ''],
  ['/', ''],
  ['////', ''],
  ['/work', '/work'],
  ['/work///', '/work'],
  ['/work//sessions/', '/work//sessions'],
  ['/work/\n', '/work/\n'],
])('strips only trailing slashes from %j', (input, expected) => {
  expect(stripTrailingSlashes(input)).toBe(expected);
});

it('handles long slash runs before a non-slash without repeated rescans', () => {
  const input = `${'/'.repeat(100_000)}work////`;
  expect(stripTrailingSlashes(input)).toBe(input.slice(0, -4));
});
