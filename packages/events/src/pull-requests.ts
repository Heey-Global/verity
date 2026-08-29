/**
 * The "ship real pull requests" directive. Backends left to their own defaults
 * happily open draft PRs, which suppress review requests and read as stalled in
 * the session's PR chip. Verity wants every session PR review-ready, so this
 * states the rule once, repo-agnostically, alongside the other runtime nudges.
 */
export const PULL_REQUEST_SYSTEM_PROMPT = `# Pull requests (Verity)

Open every pull request as a normal, review-ready PR — never a draft. Do not pass \`--draft\` to \`gh pr create\` and do not create drafts through the API. If a PR you are working on already exists as a draft, mark it ready with \`gh pr ready <number>\`. Draft PRs hold back reviews and ready-gated workflows, and they make the session's PR status read as stalled.`;
