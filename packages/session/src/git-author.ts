/**
 * The person a turn's commits are authored by. A project's sandbox container is
 * shared by every session in the project, so its git config can only carry one
 * identity; the turn's own author travels with the turn instead and becomes the
 * agent's `GIT_AUTHOR_*` / `GIT_COMMITTER_*` environment, which git prefers over
 * `user.name` / `user.email`.
 *
 * It crosses each hop as its own request field (`gitAuthor`), never inside
 * `sessionEnv`, because an older supervisor, worker or broker rejects unknown
 * `sessionEnv` keys but ignores unknown fields. The standalone supervisor and
 * broker scripts in `features/verity-sandbox-toolkit/bin` repeat this check.
 */
export interface GitAuthor {
  readonly name: string;
  readonly email: string;
}

const MAX_NAME_BYTES = 200;
const MAX_EMAIL_BYTES = 320;
// Angle brackets delimit the email in a commit header and newlines end it: a
// value carrying either could forge a second identity line in the commit.
// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const NAME_PATTERN = /^[^\u0000-\u001f\u007f<>]+$/u;
// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const EMAIL_PATTERN = /^[^\s\u0000-\u001f\u007f<>@]+@[^\s\u0000-\u001f\u007f<>@]+$/u;

export function isGitAuthor(value: unknown): value is GitAuthor {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const { name, email } = value as Record<string, unknown>;
  return (
    Object.keys(value).length === 2 &&
    typeof name === 'string' &&
    typeof email === 'string' &&
    name.trim().length > 0 &&
    Buffer.byteLength(name) <= MAX_NAME_BYTES &&
    NAME_PATTERN.test(name) &&
    Buffer.byteLength(email) <= MAX_EMAIL_BYTES &&
    EMAIL_PATTERN.test(email)
  );
}

/** The agent environment for a turn's author: always all four keys, so neither
 *  the container's ambient environment nor an earlier turn can supply one. */
export function gitAuthorEnv(author: GitAuthor | undefined): Record<string, string | undefined> {
  return {
    GIT_AUTHOR_NAME: author?.name,
    GIT_AUTHOR_EMAIL: author?.email,
    GIT_COMMITTER_NAME: author?.name,
    GIT_COMMITTER_EMAIL: author?.email,
  };
}

/** Read the author back out of an agent environment built by {@link gitAuthorEnv}. */
export function gitAuthorFromEnv(env: NodeJS.ProcessEnv | undefined): GitAuthor | undefined {
  const author = { name: env?.GIT_AUTHOR_NAME, email: env?.GIT_AUTHOR_EMAIL };
  return isGitAuthor(author) ? author : undefined;
}
