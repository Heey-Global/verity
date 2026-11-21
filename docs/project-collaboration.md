# Project repositories and inquiries

Connect additional GitHub or Forgejo repositories in project repository settings.
The existing repository remains the default. Open a module from the session branch
sheet or with `verity repo repository open <repository-id>`. Repository-specific
instructions apply in that checkout: when the module has a root `AGENTS.md`, the
command names it on stderr so the agent reads it before working there, while its two
lines on stdout stay the checkout path and branch. Each session/module pair has an isolated
checkout and branch; reopening never resets existing history. Sandbox callers receive
container-accessible checkout paths. Session deletion removes module clones after
the session runtime is fenced, using deterministic paths even after database rows
have been deleted.

Use `verity repo repository list` to inspect assignments. PR and issue commands
accept `--repository <id>` and infer it from module checkouts. The sandbox supplies
the session identity. `pr create --depends-on <PR-URL>` records informational PR
dependencies; it does not authorize merging or schedule dependent work.

Remote credentials stay on the server. Module clones retain the sandbox's broker
proxy and CA configuration and use a host-specific capability helper. Removing an
assignment prevents subsequent brokered remote access while retaining workspace
history. The relay forwards forge CONNECT requests only to its fixed server broker;
the broker checks configured hosts, current repository assignments and credentials
before contacting a remote. GraphQL is validated against current GitHub assignments;
operations and remote node ownership must match a single assigned repository. The relay never opens a direct forge connection.

Deploy the matching server and project-relay images together. Existing relay
containers retain their startup configuration; update existing project sandboxes
through the normal managed sandbox update flow before using cross-host modules.
No worktree data needs migration. Additive database migrations preserve existing
project repositories as the default and leave legacy worktrees in place.

A session can ask another project a question or request a change there. Every
request waits for a person's decision on an approval card, shown in the asking
session, on Home and on the target project's page. Nothing reaches the target
project before the request is allowed; its target session is created only then,
so a rejected request leaves nothing behind. The card offers:

- **Allow once** delivers this request.
- **Always allow** delivers this question and lets later questions from the same
  source project to the same target project run without a card. It is offered for
  questions only and needs execution rights on both projects.
- **Reject** closes the request.

Changes always need their own approval. Project settings > Agents > Allowed project
inquiries lists the targets a project has always allowed; revoking one puts its
questions back behind a card and stops questions it admitted that have not been
delivered yet. Deciding requires execution rights on the target project, and
delivery checks the requesting user's execution rights on both projects again.
Each source session reuses one target session per target project. Questions run
read-only. Peer messages do not grant execution authority.

Requests and answers survive restarts. Recovery processes at most 100 requests and
100 answers per pass, advancing through the queue even when earlier deliveries
remain busy, revoked or unavailable. Failed deliveries are retried on subsequent
sweeps. Inquiry targets cannot forward requests, and each source project is limited
to 20 requests per day. There is no monetary budget for inquiries.

## Instructions across repositories

Project settings > Instructions holds the project's own Instructions, which every
agent in the project receives regardless of how many repositories are connected.
Below them, the screen lists the root `AGENTS.md` of each connected GitHub or
Forgejo repository, read from the code host at the repository's default branch.
These files are shown read-only: they belong to their repository and change
through its normal commit and review flow. They add rules for work in that
repository and never replace the project's Instructions. Sessions use the version
on their own branch, which can differ from the default branch shown in settings.

A repository without an `AGENTS.md` is omitted. A repository whose code host
cannot be reached is named as not loaded, so a missing file and an unanswered
request are never shown the same way. Reading the list requires read access to
the project; editing project Instructions requires manage access.
