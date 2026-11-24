type Git = (args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;

const GITHUB_REPOSITORY_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/iu;

/**
 * Point an existing clone's `origin` at its repository's current GitHub URL.
 *
 * Only an origin that still names a different GitHub repository path is
 * rewritten — the state a rename on GitHub leaves behind once the project has
 * followed it. Any other origin (another host, a local path, none) is left as
 * it is, and so is one that already names the repository.
 */
export async function followGitHubOrigin(git: Git, clonePath: string, url: string): Promise<void> {
  const wanted = GITHUB_REPOSITORY_URL.exec(url);
  if (wanted === null) return;
  let current: string;
  try {
    current = (await git(['-C', clonePath, 'remote', 'get-url', 'origin'])).stdout.trim();
  } catch {
    return; // No `origin` to follow.
  }
  const named = GITHUB_REPOSITORY_URL.exec(current);
  if (
    named === null ||
    `${named[1]}/${named[2]}`.toLowerCase() === `${wanted[1]}/${wanted[2]}`.toLowerCase()
  )
    return;
  await git(['-C', clonePath, 'remote', 'set-url', 'origin', url]);
}

/** The project's GitHub URL under its current name. Minting a token may just have
 *  moved the project to its repository's new name, so the record is read again. */
export async function currentGitHubUrl(
  store: { getProject(id: string): Promise<{ owner: string; repo: string } | undefined> },
  project: { id: string; owner: string; repo: string },
): Promise<string> {
  const current = (await store.getProject(project.id)) ?? project;
  return `https://github.com/${current.owner}/${current.repo}`;
}
