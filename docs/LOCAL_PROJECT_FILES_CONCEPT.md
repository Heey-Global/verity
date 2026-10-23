# Project files without a repository

**Status:** Proposed — no implementation yet
**Scope:** Verity server, provisioner, store, agent runtime, mobile explorer, documentation
**Related:** [ADR 0022](adr/0022-knowledge-folder-and-retrieval.md),
[session worktree lifecycle](SESSION_WORKTREE_LIFECYCLE_CONCEPT.md),
[knowledge folders](knowledge.md), [connections](connections.md)

## 1. Outcome

Every project presents one file tree with three user-facing areas: **Sources**, **Documents**,
and, only when a code host is connected, **Code**. A local project has no repository, no
branches, no commits, and no "Save to project" step. Sessions in a local project read Sources
and write Documents directly; the explorer's per-file versions are the history users see.

Git remains the storage model of the Code area, which exists only for projects linked to
GitHub or Forgejo. "Adding code" to a project means connecting a code host. Verity does not
offer a local repository without a remote.

This concept changes how project files are presented and where local sessions work. It does
not change the knowledge folder storage layout from ADR 0022, which remains the source of
truth for Sources and Documents, nor the pull-request workflow for repository projects.

## 2. Problem

A local project today is a Git repository with an empty initial commit. Each session receives
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

The code states one technical reason for the repository: `git worktree add` requires a commit
to branch from. No design record explains a product reason.

## 3. Model

Internal folder names stay as they are; the user-facing labels change. The table lists the
user-facing name first.

| Area | Content | Writers | Storage today |
| --- | --- | --- | --- |
| Sources | Immutable input: uploads, meeting recordings and transcripts, Drive and web imports | Imports only; agents read | `knowledge/<projectId>/sources/` |
| Documents | Everything produced in the project: notes, drafts, reports, distilled knowledge | Users through the explorer, agents through the mount | `knowledge/<projectId>/insights/` |
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

## 4. Local projects

A local project consists of Sources, Documents, About this project, and access to Global.
Creating one allocates the knowledge folder only; the provisioner does not initialize a
repository, and no clone directory is reserved for it.

### Sessions

A session in a local project runs in the project sandbox with the knowledge mounts described
in ADR 0022: Sources and extracted text read-only, Documents read-write. There is no worktree.
The agent's working directory is a **session scratch folder**, a plain directory that exists
for the lifetime of the session and is deleted with it. Downloads, intermediate files, and
temporary scripts belong there; deliverables belong in Documents. The session instructions
state this explicitly, so the agent does not leave results in scratch.

The explorer shows Sources, Documents, and Global for a local session. The scratch folder is
shown as a fourth entry only while it contains files, labeled as session files, so the user
can retrieve a download without treating it as project content. Explorer upload into
Documents and Sources works as today.

### Saving and versions

There is no save step. An agent write to Documents is visible to the user and to other
sessions as soon as it happens. Two mechanisms replace branch isolation:

- **File versions.** The explorer already records a private version beside every file it
  saves. Agent writes bypass that path, so the server records a version for Documents files
  changed by a turn: it snapshots the Documents tree before a turn and captures the previous
  content of each changed file into the same history directory after the turn. The editor's
  Versions action then shows user and agent edits in one list.
- **Optimistic conflict check.** The explorer's editor keeps its existing version check on
  save. Two sessions writing the same document concurrently is last-writer-wins at the
  filesystem level, with the earlier content retained as a version. This is the behavior
  users expect from shared document storage and is acceptable for text; it is not acceptable
  for code, which is why code keeps worktrees.

The "Changes from this session" bar, the `save-to-project` route, the save-approval ref, and
`mergeLocalSession` have no purpose for a project without a repository and are removed once
no local project carries one.

## 5. Development projects

A project connected to GitHub or Forgejo has all three areas. Code is the repository: session
worktrees, branches, the pre-push review gate, the secrets scan, and pull requests remain
exactly as today. Sources and Documents are the project's knowledge folder with the new
labels. Repository documentation such as architecture decisions, build instructions, and
tests stays in Code; the boundary from the knowledge folder documentation is unchanged.

The agent instructions for a development session already distinguish repository artifacts
from knowledge. They gain one sentence: Documents is for material that should outlive the
branch and is not a repository artifact.

### Adding code to a local project

A local project becomes a development project by connecting a code host, which is the
existing "link project" flow reduced to its remote case. Verity clones the repository into a
new clone directory and new sessions receive worktrees. Documents and Sources are not pushed;
they stay in the knowledge folder. If a user wants a document in the repository, they move or
copy it there in a session.

The option to initialize a repository without a remote is not offered. A project that needs
version control needs a code host, and a code host is the only place where Verity's review,
scan, and pull-request workflow applies.

## 6. Migration of existing local projects

Existing local projects carry a repository with committed files, possibly several session
branches with unsaved work, and a knowledge folder. Migration runs once per project when the
feature is enabled and must not lose any file.

1. **Settle sessions.** The migration waits for idle sessions and refuses to proceed while a
   turn or meeting job runs. Session branches that differ from the base are listed.
2. **Move committed files.** The tracked files of the base checkout, excluding `.git` and
   Verity-managed directories, are copied into Documents under a subfolder named after the
   project. A file that already exists in Documents is not overwritten; the copy receives a
   conflict suffix and is recorded in a migration note.
3. **Preserve unsaved session work.** For each session branch with changes, the changed files
   are copied into Documents under a subfolder named after the session, and the session
   receives a server-authored note naming the new paths. No history is transplanted.
4. **Retire the repository.** The clone directory is archived in place under the data root
   with the project id and a timestamp, not deleted, so an operator can recover anything the
   copy missed. Backups continue to include it until an operator removes it.
5. **Switch the project.** The project row loses its clone directory; sessions created from
   now on receive a scratch folder instead of a worktree.

A project whose repository contains nothing but the empty initial commit skips steps 2 to 4.
The migration writes `migration.md` into Documents describing what was moved and where, so
the result is self-explanatory to the user.

## 7. Retrieval readiness

ADR 0022 defers indexed retrieval and requires any index to remain derived state. The model
in this concept is what such an index will be built on, so three properties are fixed now:

- **Addressing.** Every indexed file is identified by project, area, and path, where area is
  Sources, Documents, or Global. Code is indexed separately or not at all. Citations in agent
  answers use this address, which is also what the explorer opens.
- **Provenance.** Each Sources file carries metadata about its origin, import time, and
  digest; the extraction metadata under `.text/` already records most of it. Documents files
  record the session or user that last changed them, through the version history. A later
  index reads these fields for filters and attribution instead of inferring them.
- **Change scope.** Sources are immutable, so their extracted text and embeddings are
  computed once per digest. Only Documents change after import and need incremental
  reindexing. Scratch folders are never indexed.

Nothing here requires the index to exist. Filesystem search over the extracted text remains
the retrieval path until the folder sizes justify more.

## 8. Security and operational boundaries

- Sources, extracted text, About this project, and Global stay read-only in sandboxes.
  Documents stays the only writable knowledge mount, as today.
- The scratch folder is private to its session and outside every knowledge folder. It is not
  mounted into other sessions and is removed with the session.
- The commit-time secrets scan no longer runs for local projects, because nothing is
  committed. Documents is not published anywhere by Verity, so the exposure is a leaked
  secret stored in project files. The explorer's existing upload checks remain, and a scan on
  agent writes to Documents can be added as a derived check later; it is not a precondition.
- Connecting a code host does not copy Documents or Sources into the repository, so linking
  cannot publish knowledge by accident.
- Backups already include the knowledge folders. The archived repository from migration is
  included until it is removed.

## 9. Mobile and documentation changes

- Explorer root labels become Sources, Documents, Global, and, when present, Code. The
  breadcrumb short forms follow. Local sessions do not show Code.
- The project screen for a local project offers "Connect GitHub" or "Connect Forgejo" where
  it offers linking today, with the explanation that this adds a Code area.
- The "Changes from this session" bar and its save action are removed for local projects.
- The New menu in Documents keeps Markdown creation; the New menu in Sources offers upload
  only.
- Getting started describes a local project as a place for files and knowledge, and a
  connected repository as the way to work on code. The knowledge documentation adopts the
  new labels and drops "insights" from user-facing text while keeping the folder name.

## 10. Open questions

- Whether Documents should keep the internal folder name `insights/` indefinitely or be
  renamed in a later migration. The label change does not depend on it.
- Whether the explorer should allow moving a file from Documents to Sources, which would make
  a generated document immutable input for later work. This is not offered today.
- How long archived repositories from migration are retained before an operator is prompted
  to remove them.
- Whether the per-turn version capture for agent writes should also cover Global Documents,
  which agents publish through the project-bound tool rather than writing directly.

## 11. Implementation sequence

1. Relabel the explorer roots and the knowledge documentation. No storage change.
2. Add the session scratch folder and the per-turn version capture for Documents, behind a
   flag, for local sessions that still have a worktree.
3. Create new local projects without a repository: no clone directory, no `initLocalRepo`,
   scratch folder instead of worktree, explorer without Code.
4. Reduce project linking to the remote case and ensure linking never imports the knowledge
   folder.
5. Migrate existing local projects as described in section 6.
6. Remove the local save and merge routes, the save-approval ref handling, and the mobile
   save bar once no local project carries a repository.
