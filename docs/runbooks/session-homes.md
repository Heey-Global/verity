# Persistent session homes

Every persisted Verity session owns a stable directory under the runner's volume:
`<runtime>/session-homes/<sha256(verity-session-id)>`. The runtime is mounted at
`/run/verity-runner` in the sandbox. Worktrees remain separate from native agent
state. Backend switches do not delete any part of this directory.

| Path within the session home | Purpose | Lifetime |
| --- | --- | --- |
| `claude/projects`, `claude/tasks`, `claude/plans` and other Claude state directories | Claude native conversations and auxiliary state | Session |
| `codex/sessions`, `codex-state`, `codex/thread-writer-locks` | Codex rollouts and native SQLite state | Session |
| `data`, `state`, `cache` | OpenCode XDG state and supporting agent data | Session |
| `codex/config.toml`, `.gitconfig`, `.claude.json`, `config` | Broker-managed gateway and launch configuration | Refreshed before launch |
| `tmp` | Explicitly temporary turn files | Turn |

The privileged broker owns policy directories and replaces managed files with
atomic renames. The agent identity owns writable state subdirectories. A session
has at most one active home lease; overlapping launches fail instead of choosing
a second path or refreshing policy under a running backend. Knowledge-isolated
jobs use disposable homes and do not inherit session state.

## Filesystem confinement

Normal project agents run through the filesystem sandbox with a writable
worktree and current session home. The policy is inherited by their child
processes. Knowledge is readable, with writes limited to project insights.
Only the individual container-configured credential and CA files are added;
the runner runtime and the session-home parent are never granted as roots.
Planning retains a read-only worktree. Control turns use the exception below.

The helper uses Landlock where available and mount namespaces otherwise. Both
architecture prebuilts must be rebuilt from the helper source before rollout;
installing a broker that uses new helper arguments with older binaries fails
closed. Source-compiled tests do not verify the checked-in release artifacts.

## Control runner Docker exception

Normal Control runner turns retain their existing direct Docker access. Access
to the Docker daemon is host-root-equivalent and can bypass filesystem
confinement, including the boundary between session homes. Control therefore
does not provide strict cross-session isolation against code using Docker.
Separate session storage and complete session-home deletion still apply.

This exception does not grant Docker access to project runners. Planning and
knowledge-isolated turns continue to drop Docker access and retain their
existing filesystem restrictions. Future confinement changes must preserve
this distinction rather than treating separate directories as proof of isolation.

The supervisor prepares storage before the server restores a transcript. This
keeps server capture and native backend resume on the same paths. Servers require
the `persistentSessionHomes` capability before starting persisted ACP sessions;
an older sandbox must be recreated with the new toolkit.

Session-home deletion runs through the privileged broker. It writes a durable
start fence, stops matching agent process groups, waits for their exit cleanup,
and removes the entire home. The fence prevents a late start from recreating a
deleted conversation. Legacy shared-runner artifacts require separate ownership
resolution; a native state file with uncertain ownership must not be assigned to
another session or copied into its home.

This document describes the storage contract. Migration, confinement and lifecycle
verification must accompany rollout; a new path alone does not establish that
those guarantees have been deployed.
