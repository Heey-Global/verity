/**
 * The "ship real pull requests" directive. Backends left to their own defaults
 * happily open draft PRs, which suppress review requests and read as stalled in
 * the session's PR chip. Verity wants every session PR review-ready, so this
 * states the rule once, repo-agnostically, alongside the other runtime nudges.
 */
export const PULL_REQUEST_SYSTEM_PROMPT = `# Pull requests (Verity)

Open every pull request as a normal, review-ready PR — never a draft. Do not pass \`--draft\` to \`gh pr create\` and do not create drafts through the API. If a PR you are working on already exists as a draft, mark it ready with \`gh pr ready <number>\`. Draft PRs hold back reviews and ready-gated workflows, and they make the session's PR status read as stalled.`;

/**
 * The same rule for a project whose code host has no CLI in the sandbox
 * (Forgejo today, GitLab later). `gh` only talks to github.com, so an agent
 * following {@link PULL_REQUEST_SYSTEM_PROMPT} there fails on its first PR.
 * `verity-repo` runs every action on the Verity server through the project's
 * code host, so this text stays the same for each host that is added; only the
 * name changes.
 */
export function repoToolPullRequestSystemPrompt(hostName: string): string {
  return `# Pull requests and issues (Verity)

This project's code host is ${hostName}. \`gh\` only talks to GitHub and does not work here. Push branches with \`git push\` as usual, and use \`verity-repo\` for pull requests and issues — Verity runs each command on ${hostName} for you; no token or API call is needed:

- \`verity-repo pr create --title "<conventional title>" --body-file -\` opens a pull request for the current branch against the default branch (\`--base <branch>\` to choose another).
- \`verity-repo pr view [<number>]\` and \`verity-repo pr ready [<number>]\` act on the current branch's pull request unless you name one.
- \`verity-repo issue list\`, \`verity-repo issue view <number>\`, \`verity-repo issue comment <number> --body-file -\`.

Open every pull request as a normal, review-ready PR — never a draft, so no \`WIP:\` or \`[WIP]\` title prefix. If a PR you are working on already is a draft, run \`verity-repo pr ready\`. Draft PRs hold back reviews and ready-gated workflows, and they make the session's PR status read as stalled. If \`verity-repo\` reports an error, report it as stated; do not fall back to \`gh\` or to calling the ${hostName} API directly.`;
}
