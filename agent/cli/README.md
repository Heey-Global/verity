# Sandbox commands

| Canonical command            | Compatibility executable              | Display title                  | Skill          |
| ---------------------------- | ------------------------------------- | ------------------------------ | -------------- |
| `verity dev-server <verb>`   | `verity-dev-server`                   | Verity · Dev Server · Action   | dev-server     |
| `verity dependencies <verb>` | `verity-dependencies`                 | Verity · Dependencies · Action | dependencies   |
| `verity review <verb>`       | `verity-code-review`                  | Verity · Review · Action       | push-review    |
| `verity checks <verb>`       | `verity-local-checks`                 | Verity · Checks · Action       | dependencies   |
| `verity repo <verb>`         | `verity-repo`                         | Verity · Repository · Action   | pull-request   |
| `verity skill list/read`     | none                                  | Verity · Skills · List / Read  | core discovery |
| MCP `verity_memory_append`   | `verity-memory append` (project only) | Verity · Memory · Append       | memory-curate  |

The dispatcher resolves fixed installed siblings and passes arguments as an argv array. It never evaluates shell text. Legacy helpers remain one implementation during migration. Git signing, credential brokers, secret scanning and review-base helpers remain internal hook/transport mechanisms. Standard executables retain existing wrappers.

## Operation inventory

All commands below inherit the session's sandbox/project binding. Read-only commands do not authorize adjacent writes. Titles follow the domain label above plus the title-cased operation; repository operations include PR or Issue.

| Domain         | Operations                               | Scope / authorization                                                                      |
| -------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `dev-server`   | `list`, `status`, `logs`                 | Project-managed server metadata and logs                                                   |
| `dev-server`   | `add`, `update`, `remove`                | Project-managed entry configuration; server permission checks remain authoritative         |
| `dev-server`   | `start`, `stop`, `restart`               | Project-managed process lifecycle; execution approval remains authoritative                |
| `dev-server`   | `announce`, `scan`                       | Compatibility listener metadata only; never substitutes for managed start                  |
| `dependencies` | `status`                                 | Current Code workspace dependency compatibility                                            |
| `dependencies` | `install`                                | Current Code workspace; requires authorized installation                                   |
| `review`       | `status`                                 | Current branch review coverage                                                             |
| `review`       | `run`                                    | Current branch; isolated reviewer through the existing review broker                       |
| `review`       | `mark`                                   | Current branch receipt, only after review and triage                                       |
| `checks`       | `status`                                 | Current workspace's dependency-bound skip receipt                                          |
| `checks`       | `skip`, `reset`                          | Changes only the authorized local check decision; never bypasses secret scanning or review |
| `repo`         | `pr view`, `issue list`, `issue view`    | Server-bound project repository reads                                                      |
| `repo`         | `pr create`, `pr ready`, `issue comment` | Server-bound repository writes; requires publication/message authority                     |
| `skill`        | `list`, `read`                           | Image-owned built-ins; no repository discovery or execution                                |

The retired project-only `verity-memory append` remains a compatibility entry point. New calls use the scoped MCP Memory operation. Internal credential, signing, hook and transport executables remain implementation details rather than additional advertised capabilities.
