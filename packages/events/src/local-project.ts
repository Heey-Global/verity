/**
 * The directive for a project created WITHOUT a GitHub repository
 * (`kind: 'local'`). Such a project's clone is an ordinary git repo with no
 * `origin`, so `git push` has no destination, `gh` has no repo to talk to, and
 * the token broker refuses to mint a GitHub token for it — three unrelated-
 * looking failures that never say "this project has no GitHub repository".
 *
 * Verity's own surfaces already know this: the session shows the local Merge bar
 * instead of the pull-request bar. What leaks is the AGENT's own suggestions —
 * the Quick-Action prompt names "Push + PR" as an example label, and those chips
 * are rendered verbatim, so a tap dispatches a turn asking for a push that
 * cannot succeed. This fragment replaces that guidance for local projects, and
 * {@link PULL_REQUEST_SYSTEM_PROMPT} is omitted alongside it rather than left to
 * contradict this text.
 *
 * Project facts reach a backend context once, when it is created — the same
 * snapshot the operator-curated project memory and the server's session prompt
 * take. That is survivable for those (a stale note is merely stale) but not for
 * a prohibition: a local project can be linked to GitHub later, and a session
 * that predates the link would refuse pushes forever on a repo that now has a
 * remote. So the text ends by naming its own expiry condition — the one fact
 * that flips it is directly observable in the worktree with `git remote`.
 */
export const LOCAL_PROJECT_SYSTEM_PROMPT = `# Local project — no GitHub remote (Verity)

This project has NO GitHub repository behind it. Its clone is a plain git repo with no \`origin\`, so pushing and pull requests are unavailable, not merely discouraged: \`git push\` has no destination, \`gh\` commands have no repo, and the credential broker will not issue a GitHub token. Do not attempt any of them, and do not report a push or PR as a next step.

This overrides the pull-request and Quick-Action guidance elsewhere in these instructions. Never offer "Push", "Push + PR", "Open a PR", or any other remote-bound label as a choice here — the chip would be tappable and the resulting turn would fail. Offer the local equivalents instead, e.g. "Committen" / "Nicht committen".

Work the same way otherwise: branch, commit, and run the project's checks as usual. Landing a session branch is the operator's action through the session's Merge bar, which merges it into the project's base branch locally, so leave the branch committed and say it is ready to merge rather than merging it yourself.

This note was written when the session started, and a project CAN be linked to a GitHub repository afterwards. So before you tell the operator that pushing is impossible, confirm it: if \`git remote -v\` in the worktree now shows an \`origin\`, the project has been linked since, this whole section is obsolete, and you should push and open a review-ready pull request in the normal way.`;
