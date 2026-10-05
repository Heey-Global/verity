# Session workspace isolation

Project session agents run in separate containers with independent Git clones. A
session's writable `/work` mount contains only its checkout, including its own
`.git`, index, refs, object database, configuration, and dependency installs. The
central project clone remains available to server-controlled project management;
it and sibling session directories are not mounted into an agent container.

A Git worktree alone is not a permissions boundary. The legacy layout exposed the
whole project directory and shared Git administrative data to every session.
Pruning from a container with different visible paths could therefore remove live
sessions' administrative directories. Legacy worktrees are locked against pruning,
and the agent Git wrapper blocks dangerous worktree administration. These are
additional safeguards; the container mount boundary provides isolation.

## Container and broker boundaries

The server derives each session container from the project's configured image and
reviewed infrastructure mounts. It supplies a private runner runtime directory and
session identity. The parent workspace, shared writable dependencies, parent
runner directory, and Docker socket are excluded, including for sessions working
on the Verity control project. Unsupported shared mounts or unsafe container
settings refuse session startup instead of falling back to a shared workspace.

Project knowledge remains an explicit shared exception: sources and shared
knowledge are read-only, while `/knowledge/insights` remains writable project
knowledge. Infrastructure credentials and configuration use reviewed read-only
mounts. Broker requests use the session identity and are restricted to that
session's workspace and runtime.

Local saves transfer Git bundles through the trusted server between the session
container and the project management container. Each Git process runs inside its
own container. Temporary import refs do not overwrite project branches. The
session receives the resulting merge commit before its post-merge checkout and
branch cleanup. Pull requests continue to use the project's original remote.

## Existing sessions

Legacy worktrees are not automatically rewritten, and an incompatible checkout
cannot resume through the isolated runner until it is migrated. An explicit
`POST /sessions/:id/isolation/migrate` operation requires an idle session, stops its
session-owned processes, and preserves a complete backup of its working files and
available Git metadata before preparing a private destination outside the shared
project directory. Its index, staged-only objects, branch or detached HEAD, and
available merge/rebase state are retained. Metadata symlinks or object alternates
require manual recovery rather than silently preserving shared Git storage.

The session workspace record changes only after the destination passes validation.
The original checkout and backup remain available for recovery; removal is a
separate manual cleanup step after verification. Already-lost indexes or operation
state cannot be reconstructed by isolation migration. Backup directories are local
operational data and must not be committed or published.

## Verification

Focused tests cover clone storage, source/sibling safety under pruning and garbage
collection, private commits, fetch credential redaction, migration state and
backups, idle admission, and bundle-based local merging through separately scoped
Git runners. Protection tests deliberately introduce shared object alternates or
metadata symlinks and require validation to reject them.

The real-container integration test is opt-in. Set `VERITY_ISOLATION_TEST_IMAGE` to
a locally available compatible runner image and `VERITY_ISOLATION_TEST_ROOT` to a
writable fixture directory available at the same absolute path to the server
process and Docker daemon. Set `VERITY_ISOLATION_DOCKER_URL` when using a daemon
other than the default `unix:///var/run/docker.sock`, then run:

```sh
npx vitest run packages/server/src/session-sandbox.integration.test.ts
```

Without the image and fixture-root settings, this suite is skipped. Unit and
real-Git tests do not establish that the deployed Docker mount boundary works;
the real-container suite must pass in a suitable deployment environment.
