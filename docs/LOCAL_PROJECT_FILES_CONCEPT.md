# Local projects without Git

## Goal

A local project provides durable Sources, Documents and Global files. Sessions can
work in parallel without Git, branches, commits or a manual Save to project step.
Code exists only after connecting GitHub or Forgejo. Retrieval and RAG are outside
this change.

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
