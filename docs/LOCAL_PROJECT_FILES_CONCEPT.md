# Local projects without Git

**Status:** Implemented in this change; rollout requires legacy migration.
**Scope:** Verity server, provisioner, store, agent runtime, mobile explorer, documentation
**Related:** [ADR 0022](adr/0022-knowledge-folder-and-retrieval.md),
[session worktree lifecycle](SESSION_WORKTREE_LIFECYCLE_CONCEPT.md),
[knowledge folders](knowledge.md), [connections](connections.md)

## Goal

A local project provides durable Sources, Documents and Global files. Sessions can
work in parallel without Git, branches, commits or a manual Save to project step.
Code exists only after connecting GitHub or Forgejo. Retrieval and RAG are outside
this change.

## Background

Before this change, a local project was a Git repository with an empty initial commit. Each session receives
a Git worktree on its own branch, and the only way to make a session's work visible to the
project is a "Save to project" turn that asks the agent to review, commit, and approve the
tip, followed by a `--no-ff` merge into the base checkout. The session explorer shows three
roots, "Repository", "Project Knowledge", and "Global Knowledge", and the knowledge root is
subdivided into `sources/documents`, `sources/meetings`, and `insights`.

Users who create a local project to work on documents, research, or meetings never asked for
version control and have no model for what "Repository" means next to "Knowledge", or why a
finished text is an "insight". The Git layer adds conflicts, dirty-worktree refusals, and
agent turns spent on commit hygiene, while the features it enables are either unused or
achievable without it:

- Session isolation through branches suits code, where a half-finished change breaks a build.
  Document work expects one current version per file plus a version history, which the
  explorer's private file history already provides independently of Git.
- The push-gated review and secrets scan never run for a local project, because there is
  no remote.
- Linking a local project to GitHub later merges its entire history into the repository, so
  documents and meeting notes end up in a code repository by default.

The previous implementation required the repository for one technical reason for the repository: `git worktree add` requires a commit
to branch from. No design record explains a product reason.

## File areas

Internal folder names stay as they are; the user-facing labels change. The table lists the
user-facing name first.

| Area | Content | Writers | Storage |
| --- | --- | --- | --- |
| Sources | Immutable input: uploads, meeting recordings and transcripts, Drive and web imports | Imports only; agents read | `knowledge/<projectId>/sources/` |
| Documents | Everything produced in the project: notes, drafts, reports, distilled knowledge | Users through the explorer, agents through session working copies | `knowledge/<projectId>/insights/` |
| Code | The project's repository on a connected code host | Agents through session worktrees and pull requests | project clone and session worktrees |

Two further elements complete the tree:

- **About this project** is `overview.md`, the bounded context given to fresh sessions.
  It stays append-only through `verity-memory`.
- **Global** is the library readable by every project, with the same Sources and Documents
  organization. The label stays "Global" rather than "Shared": in Verity, sharing means
  giving external people access through Uplink, and the global library involves no one
  outside the installation. The folder keeps its internal name `shared/`.

The Sources/Documents split is deliberate and is kept. It is the model users know from
notebook-style research tools: originals are never edited, and generated material is kept
apart from them. It also protects originals from agent edits and gives later retrieval a
stable notion of provenance. What changes is that the split is no longer presented as a
second tree next to a repository, and that the writable area is no longer called "insights".

## Storage and working directories

Sources are immutable reference material under `knowledge/<projectId>/sources`.
Documents remain under `knowledge/<projectId>/insights`; the internal folder name
is retained for compatibility. Global is the shared, read-only knowledge scope.
These collections are not part of a Code repository.

Each document session has a durable working copy under the project's
`.verity-document-sessions` directory. It is the session's working directory and
contains its Documents. It is not disposable scratch. Code sessions retain their
Git worktree and use a separate Documents working copy beside the Code worktrees.
Canonical Documents are mounted read-only for project agents; server-mediated
publication and Explorer writes share the project knowledge mutation lock.

Session deletion retains the working copy, including unmerged changes. The
Explorer exposes canonical Documents and session working copies, including those
whose sessions have been deleted. Sources and Global are separate roots; Code is
shown only for Code sessions.

## Automatic publication

Before a turn, the server refreshes working-copy files that still match their
recorded base versions. Locally edited files remain unchanged. After a turn, the
server compares each changed file with its base and the current canonical version
under a short server-side mutation lock.

A change whose canonical version still matches its base is published atomically
per file. Repeated publication of identical bytes is idempotent. Replaced canonical
bytes enter the existing Explorer file-history layout. A durable intent records
publication across server interruption, independently of session backend state.

Concurrent changes preserve the canonical file and put the proposed version in
`Documents/Conflicts/<id>/proposed`, with a `conflict.json` describing the original
path, base and competing versions. Deletions are explicit proposals. Renames are
represented as deletion and creation; binary files receive the same comparison
and preservation behavior. A file/directory collision never recursively replaces
another writer's directory. Conflict resolution must be explicit. Refresh retains both trees and their base
versions when a file/directory replacement would collide with a working copy;
subsequent turns can proceed and edits to that retained copy produce conflicts.

Working-copy refresh retains both a byte snapshot and the previous inode in
private file history so writes through an already-open descriptor remain
recoverable. Actively changing files are refused during snapshotting. Snapshot
sizes are bounded to protect the server; files that cannot be snapshotted remain
in their working copy for follow-up.

## Connecting Code

Connecting GitHub or Forgejo fetches that repository into the Code area. It never
imports Documents into the repository or pushes legacy project history. Reserved
Verity directories and collisions with existing local files are refused. Checkout
recovery materializes missing tracked files without resetting existing edits.
Existing document sessions keep their document working directories and behavior
after the project gains a Code connection.

## Legacy migration

Migration requires an idle project and a stopped old sandbox. A durable manifest
separates copying, archiving and database transitions. The server inventories and
copies the project and session trees, including ignored, untracked and orphaned
session files, into a uniquely named Documents collection. Files are verified by
hash. A complete temporary file is linked exclusively into its destination;
retries verify existing destination bytes instead of replacing them.

Only after successful copies does the complete original workspace move to a
server-owned archive, including Git history. Session rows then switch to durable
Document working copies and clear stale backend bindings. A restart resumes the
recorded migration rather than copying a newly created plain workspace. Unsupported
non-regular files or session paths outside the managed root stop migration while
retaining originals for review.

## Verification

Behavioral coverage must include parallel publication, conflicts for edits and
deletions, binary preservation, file history, journal recovery, retained session
working copies, interrupted migration and interrupted Code checkout. Runtime and
Explorer integration must preserve the same lock and mount boundaries. Connected
Code worktrees and pull-request workflows retain their existing Git behavior.

## Retrieval readiness

ADR 0022 defers indexed retrieval and requires any index to remain derived state. The model
in this concept is what such an index will be built on, so three properties are fixed now:

- **Addressing.** Every indexed file is identified by project, area, and path, where area is
  Sources, Documents, or Global. Code is indexed separately or not at all. Citations in agent
  answers use this address, which is also what the explorer opens.
- **Provenance.** Each Sources file carries metadata about its origin, import time, and
  digest; the extraction metadata under `.text/` already records most of it. A later index must also attribute Documents changes to their producing session or user;
  existing file history retains prior content but does not guarantee that attribution.
  Retrieval must use explicit provenance instead of inferring authorship from file paths.
- **Change scope.** Sources are immutable, so their extracted text and embeddings are
  computed once per digest. Only Documents change after import and need incremental
  reindexing. Session working copies are not indexed as canonical content.

Nothing here requires the index to exist. Filesystem search over the extracted text remains
the retrieval path until the folder sizes justify more.

## Open questions

- Whether Documents should keep the internal folder name `insights/` indefinitely or be
  renamed in a later migration. The label change does not depend on it.
- Whether the explorer should offer a dedicated conversion from Documents to Sources, making
  a generated document immutable input beyond the explicit source-import workflow.
- How long archived repositories from migration are retained before an operator is prompted
  to remove them.
- Whether the per-turn version capture for agent writes should also cover Global Documents,
  which agents publish through the project-bound tool rather than writing directly.
