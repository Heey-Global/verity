---
name: push-review
description: Use before pushing code or satisfying the pre-push review gate.
---

# Pre-push code review gate

Verity sandboxes install a git `pre-push` hook that blocks a push, on every branch, until each pending commit is covered by the review marker `.agents/.last-code-review-sha`. When a push is blocked that way, satisfy the gate with two commands, in this order:

    verity review run     # reviews the branch diff, prints concise findings
    verity review mark    # records HEAD, after the findings are triaged

`run` performs the review in an isolated reviewer, so the full reviewer prompt never lands in this chat. Triage its findings against the requested outcome: fix BLOCKER and HIGH findings; fix MEDIUM findings when they identify a concrete correctness or maintainability problem in scope; and do not expand the task for LOW cleanup. A finding may be declined with a brief reason when it is incorrect or out of scope. Re-run the review after a fix changes HEAD; a declined finding alone does not require another pass.

`run` is synchronous: keep the turn active until it finishes. Do not detach it with `nohup` or `&`: Verity cannot see a detached process, so teardown can terminate the reviewer. If a tool returns before the command finishes, wait or poll for its result and exit status before ending the turn. On interruption or failure, report the concrete failure. Do not mark a failed or interrupted review, or promise a later automatic report without an established managed continuation.

`mark` only writes the marker — it verifies nothing, and marking without running and triaging the review turns the gate green on a diff nobody assessed. Never do that to get past a blocked push.

Do not review the diff inline in this chat instead, and do not improvise a backend-specific sub-agent, live agent, or slash command for it: no backend registers a `code_review` agent, so improvising resolves to a missing agent path and the turn dies on a tool call that never returns. If a push is blocked by this gate and `verity review run` is missing or fails to start, report it as a container-provisioning bug rather than skipping the gate or bypassing the hook with `--no-verify`.

The same hook runs the repository's lint and format scripts first, on every branch. A requested push authorizes automatic preparation of missing compatible dependencies and execution of those checks, without another confirmation. Use `verity dependencies status` and `verity dependencies install` when preparation is needed; installation failures stop the push and must be resolved. An explicit session skip remains valid only while its dependency fingerprint matches. Never bypass the hook with `--no-verify`; the sandbox git wrapper refuses that push. Older hooks that ask whether to install can be handled by installing and retrying under this authorization.
