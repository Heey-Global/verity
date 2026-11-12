import { describe, expect, it } from 'vitest';
import { resolveTurnGitAuthor, type TurnGitAuthorSources } from './turn-git-author.js';

function sources(input: {
  identity?: { authorName: string | null; authorEmail: string | null };
  github?: { githubUserId: string; login: string };
  displayName?: string | null;
}): TurnGitAuthorSources {
  return {
    gitIdentity: () => Promise.resolve(input.identity),
    githubAccount: () => Promise.resolve(input.github),
    displayName: () => Promise.resolve(input.displayName),
  };
}

describe('resolveTurnGitAuthor', () => {
  it("uses the person's own git identity when it is complete", async () => {
    await expect(
      resolveTurnGitAuthor(
        sources({
          identity: { authorName: 'Holger', authorEmail: 'holger@example.com' },
          github: { githubUserId: '7', login: 'holger' },
        }),
        'admin',
      ),
    ).resolves.toEqual({ name: 'Holger', email: 'holger@example.com' });
  });

  it("falls back to the person's GitHub noreply address, never to another identity", async () => {
    await expect(
      resolveTurnGitAuthor(
        sources({
          identity: { authorName: 'Lena', authorEmail: null },
          github: { githubUserId: '42', login: 'lena-b' },
          displayName: 'Lena Berg',
        }),
        'lena',
      ),
    ).resolves.toEqual({ name: 'Lena Berg', email: '42+lena-b@users.noreply.github.com' });
  });

  // A member without any connection still commits as themselves: the commit
  // stays internal until a developer takes over, but the author is never borrowed.
  it('gives a member without connections an internal address of their own', async () => {
    await expect(resolveTurnGitAuthor(sources({ displayName: 'Mia <x>' }), 'u-1')).resolves.toEqual(
      { name: 'Mia x', email: 'u-1@users.verity.invalid' },
    );
    await expect(resolveTurnGitAuthor(sources({}), 'u-2')).resolves.toEqual({
      name: 'Verity member',
      email: 'u-2@users.verity.invalid',
    });
  });
});
