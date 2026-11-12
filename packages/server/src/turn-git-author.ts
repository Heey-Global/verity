import { isGitAuthor, type GitAuthor } from '@verity/session';
import type { UserGitIdentity } from '@verity/store';

export interface TurnGitAuthorSources {
  gitIdentity(
    userId: string,
  ): Promise<Pick<UserGitIdentity, 'authorName' | 'authorEmail'> | undefined>;
  githubAccount(userId: string): Promise<{ githubUserId: string; login: string } | undefined>;
  displayName(userId: string): Promise<string | null | undefined>;
}

/** Characters a commit header cannot carry in a name; see git-author.ts. */
function cleanName(value: string | null | undefined): string | undefined {
  const cleaned = value
    // eslint-disable-next-line no-control-regex -- control characters are what it removes
    ?.replace(/[\u0000-\u001f\u007f<>]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return cleaned === undefined || cleaned.length === 0 ? undefined : cleaned.slice(0, 120);
}

/**
 * Who a person's turn commits as. Every person resolves to an author of their own,
 * because the alternative — the shared container's configured identity — is
 * another person's:
 *
 * 1. the git identity the person set (the administrator's was carried over from
 *    the instance settings on upgrade);
 * 2. with a connected GitHub account, GitHub's noreply address, which GitHub
 *    attributes to that account without publishing a private address;
 * 3. otherwise an address under the reserved `.invalid` domain. Such a member's
 *    commits stay internal until a developer takes the session over; the
 *    author stays theirs either way.
 */
export async function resolveTurnGitAuthor(
  sources: TurnGitAuthorSources,
  userId: string,
): Promise<GitAuthor> {
  const [identity, github, displayName] = await Promise.all([
    sources.gitIdentity(userId),
    sources.githubAccount(userId),
    sources.displayName(userId),
  ]);
  const own = { name: cleanName(identity?.authorName), email: identity?.authorEmail?.trim() };
  if (isGitAuthor(own)) return own;
  const name = cleanName(displayName) ?? cleanName(github?.login) ?? 'Verity member';
  const fallbacks = [
    github === undefined
      ? undefined
      : { name, email: `${github.githubUserId}+${github.login}@users.noreply.github.com` },
    { name, email: `${encodeURIComponent(userId).replace(/%/gu, '')}@users.verity.invalid` },
  ];
  const author = fallbacks.find(isGitAuthor);
  if (author === undefined) throw new Error('no usable git author for this person');
  return author;
}
