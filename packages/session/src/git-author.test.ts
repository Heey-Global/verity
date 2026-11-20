import { describe, expect, it } from 'vitest';
import { gitAuthorEnv, gitAuthorFromEnv, isGitAuthor } from './git-author.js';

describe('git author', () => {
  it('accepts a plain name and address', () => {
    expect(isGitAuthor({ name: 'Lena Berg', email: 'lena@example.com' })).toBe(true);
  });

  // A newline or angle bracket would let the value write a second identity into
  // the commit header; anything but exactly name and email is not an author.
  it.each([
    { name: 'Lena\nAuthor x', email: 'lena@example.com' },
    { name: 'Lena', email: 'lena@example.com>' },
    { name: 'Lena', email: 'two words@example.com' },
    { name: '   ', email: 'lena@example.com' },
    { name: 'x'.repeat(201), email: 'lena@example.com' },
    { name: 'Lena', email: 'lena@example.com', extra: 1 },
    null,
    'Lena <lena@example.com>',
  ])('refuses %j', (value) => {
    expect(isGitAuthor(value)).toBe(false);
  });

  it('always sets all four variables so nothing ambient survives', () => {
    expect(gitAuthorEnv(undefined)).toEqual({
      GIT_AUTHOR_NAME: undefined,
      GIT_AUTHOR_EMAIL: undefined,
      GIT_COMMITTER_NAME: undefined,
      GIT_COMMITTER_EMAIL: undefined,
    });
    const author = { name: 'Lena', email: 'lena@example.com' };
    expect(gitAuthorFromEnv(gitAuthorEnv(author))).toEqual(author);
  });
});
