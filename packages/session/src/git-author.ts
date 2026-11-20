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

/**
 * Marks, in the worker's agent environment, a turn whose person has no signing
 * key. The broker turns it into its own frame field; only the agent sees the
 * resulting `commit.gpgsign=false`, appended after the container's own
 * `GIT_CONFIG_*` pairs so the signing setup itself stays in place.
 */
export const UNSIGNED_COMMITS_ENV = 'VERITY_UNSIGNED_COMMITS';

/** Append `commit.gpgsign=false` to the `GIT_CONFIG_COUNT` pairs of `env`. */
export function unsignedCommitsConfig(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const raw = env.GIT_CONFIG_COUNT;
  const count = raw !== undefined && /^\d{1,3}$/u.test(raw) ? Number(raw) : 0;
  return {
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${String(count)}`]: 'commit.gpgsign',
    [`GIT_CONFIG_VALUE_${String(count)}`]: 'false',
  };
}

/** Read the author back out of an agent environment built by {@link gitAuthorEnv}. */
export function gitAuthorFromEnv(env: NodeJS.ProcessEnv | undefined): GitAuthor | undefined {
  const author = { name: env?.GIT_AUTHOR_NAME, email: env?.GIT_AUTHOR_EMAIL };
  return isGitAuthor(author) ? author : undefined;
}
