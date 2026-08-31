/**
 * The pre-push code review contract, stated where every session sees it.
 *
 * Verity sandboxes install the agent-seed hooks globally (`core.hooksPath`), so
 * the gate itself is repo-agnostic: `agent-seed/hooks/pre-push` blocks a
 * feature-branch push until `.agents/.last-code-review-sha` covers HEAD. The
 * prompt says "Verity sandboxes install" rather than "every sandbox has",
 * because a repository is free to point `core.hooksPath` somewhere of its own
 * and displace the seed hooks; the fragment is then inert rather than wrong.
 * What is NOT repo-agnostic is the knowledge of how to satisfy the gate. Until
 * the commit that added this file, the hook named only the marker command — and
 * `verity-code-review mark` writes that marker without verifying anything, while
 * `verity-code-review run`, the part that actually reviews, was documented only
 * in this repository's `AGENTS.md` and in `agent-seed/README.md`, which no agent
 * reads. A session in a repository without such a file met a blocked push holding
 * the one command that turns the gate green on a diff nobody read. The hook now
 * names `run` first; this fragment carries the same contract to sessions that
 * never see the hook's text, so keep the two saying the same thing.
 *
 * The two failure modes this closes are the ones an agent reaches for on its
 * own: marking to get past the block, and improvising a `code_review` sub-agent
 * that no backend registers — the latter hangs the turn on a tool call that
 * never returns.
 *
 * Deliberately not in the conductor's resume set: an agent that has to be told
 * this again mid-context meets a blocked push and a hook message that now names
 * `run`, which is a local, recoverable stop. The resume set is reserved for
 * rules whose violation lands on someone else.
 */
export const CODE_REVIEW_SYSTEM_PROMPT = `# Pre-push code review gate (Verity)

Verity sandboxes install a git \`pre-push\` hook that blocks a feature-branch push until each pending commit is covered by the review marker \`.agents/.last-code-review-sha\`. When a push is blocked that way, satisfy the gate with two commands, in this order:

    verity-code-review run     # reviews the branch diff, prints concise findings
    verity-code-review mark    # records HEAD, AFTER every finding is addressed

\`run\` performs the review in an isolated reviewer, so the full reviewer prompt never lands in this chat. \`mark\` only writes the marker — it verifies nothing, and marking without running the review turns the gate green on a diff nobody read. Never do that to get past a blocked push.

Do not review the diff inline in this chat instead, and do not improvise a backend-specific sub-agent, live agent, or slash command for it: no backend registers a \`code_review\` agent, so improvising resolves to a missing agent path and the turn dies on a tool call that never returns. If a push is blocked by this gate and \`verity-code-review run\` is missing or fails to start, report it as a container-provisioning bug rather than skipping the gate or bypassing the hook with \`--no-verify\`. If your push is not blocked by such a hook, none of this applies — push as usual.`;
