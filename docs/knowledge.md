# Knowledge folders

Each project has a durable Knowledge folder on the Verity server. Open a
session's file explorer and choose **Sources** for reference material,
**Documents** for project outputs, or **Global** for files every project may read. Replacing a Sandbox does not remove these
files.

Verity creates this layout automatically:

```text
overview.md
sources/
  documents/
  meetings/
insights/
```

- `overview.md` is the short project context supplied to fresh agent sessions.
  The `verity-memory append` command adds operator-requested facts to this file.
- `sources/documents/` receives chat attachments selected with **Save to knowledge**,
  Google Drive imports, web sources, and source files uploaded in the explorer.
- `sources/matrix/` keeps imported Matrix conversations and attachments. Existing Matrix sources migrate automatically from `sources/documents/matrix/`; conflicting destination files stop migration without overwriting them.
- `sources/meetings/` keeps meeting audio and its transcript automatically.
- For existing files in a session worktree, agents can use the project-bound
  `verity_knowledge` `import_source` operation to copy a file into
  `sources/meetings/` or `sources/documents/`. The import refuses overwrites;
  after checking the imported file, the agent can remove the worktree original
  when a move was requested.
  Nested destination paths create missing subfolders automatically. Agents can
  create an empty subfolder with `create_source_folder` and move an existing
  project Sources file into one with `move_source`; conflicting files are preserved.
- `insights/` is the internal storage path for Documents, including notes, drafts,
  reports and distilled knowledge. Agents edit their session Documents working
  copy with ordinary filesystem tools; Verity publishes it automatically.

The assignment is determined by the entry point; no folder choice is required.
The attachment checkbox remains off by default. Meeting recordings are retained
automatically.

## Agent access and extracted text

The project folder is mounted at `/knowledge` in every project Sandbox. The mount is
read-only for project agents. Each session receives its own durable Documents
working copy; local sessions start in it, and Code sessions receive its path in
their instructions. Global files are available read-only at
`/knowledge/shared`, with the same `sources/` and `insights/` organization. Agents use ordinary
file tools such as `ls`, `grep`, and `cat`; there is no separate Knowledge tool
or Wiki maintenance flow.

Verity Control receives the Knowledge folder of its built-in `verity-control` project,
plus Global knowledge. Control retains a writable `/knowledge/insights` mount. It does not mount other projects'
Knowledge. `verity-memory append` saves explicitly requested notes to Control's own
project overview through its authenticated turn broker. Managed updates reconcile
these mounts; legacy Compose deployments receive them when the updated stack is applied.

Agents create or revise concise insights without asking first when their work produces a
durable, reusable conclusion grounded in project sources. They prefer updating an existing
insight, cite relevant source paths, and mark uncertainty. They ask before preserving sensitive
personal information or a disputed interpretation. Routine progress, transient state,
unsupported speculation, and secrets do not belong in insights.

Binary imports are processed into Markdown under a hidden `.text/` directory,
mirroring the source path. For example, `sources/documents/offer.pdf` produces
`.text/sources/documents/offer.pdf.md`. The app hides this implementation directory and
shows the extracted text when the original binary is previewed. The original is
always retained if extraction is unsupported or fails.

Extraction is bounded and currently supports searchable PDF text and common
Office formats. Image processing creates technical previews but performs no OCR
or semantic interpretation. Files beyond the processing limit remain available
as originals with an extraction note.

## Managing scope

Upload, delete, and move files from the explorer. Moving a file to Global makes
it readable by every project; moving it back to Documents limits it to the
current project. The hidden extracted text follows its source file.

Agents publish a finished project insight to `shared/insights/` with the
`verity_knowledge` `publish_shared` operation only when explicitly asked to make it
shared, global, or available to every project. Existing shared insights require their
current digest before replacement, so concurrent edits are not silently lost. Original
sources remain read-only to agents.

Knowledge folders are separate from repositories. Code, tests, build
instructions, and versioned architecture decisions still belong in the project
repository. New meeting recordings are not written to `docs/meetings/`.

There is no Wiki, folder grant screen, overview approval, or Knowledge model
setting. Retrieval indexing and semantic search may be added later on top of the
same files; the folder remains the source of truth.

## Parallel sessions and automatic publication

Local projects use Documents without Git or a manual Save to project action.
Before each turn, unchanged working-copy files refresh from canonical Documents.
After the turn, Verity compares edits with their base versions and publishes each
file atomically. Explorer edits use the same server-side lock and version checks.
Concurrent edits, deletions and binary changes preserve the canonical version and
put proposals under Documents → Conflicts. Inspect both versions before resolving
a conflict by editing the canonical document.

The Documents tab also opens session working copies and marks whether the current
session is running or has unpublished edits. Deleting a session retains its working
copy so unresolved or late edits remain reachable. Code connections fetch repository
files without exporting Documents or archived local Git history.

## Explorer editing and versions

The explorer can edit UTF-8 text files up to 1 MB in Code, Documents, and Global.
Markdown files can also be created from the New menu. Sources and retained session
working copies are read-only in the text editor.
Saving checks the version opened by the editor; a conflict offers reload,
conditional overwrite, or saving a new copy.

Each edit retains versions in a private `.verity-file-history/` directory beside
its file. Repository versions are excluded through Git's local `info/exclude`;
the explorer hides and reserves these directories in every root. The editor's
Versions action loads an earlier version as a draft; Save restores it with the
same conflict check as an ordinary edit.

A saved version is a fixed text snapshot. The original entry also retains the
previous inode, because a process with an already-open descriptor can write to
it after the explorer saves. Versions are not automatically pruned: deleting
such an inode could discard a late save. Administrators may remove history only
when those writers have finished and backups are no longer needed.

A durable capture record allows the explorer to restore an interrupted save
when its folder or file is next opened. Recovery never replaces a file already
at that name. Completed edits do not resurrect files deleted later. Private
history is local to the filesystem and is not a substitute for external backup.

## Confirmed project decisions

Agents record explicitly confirmed project decisions during the same chat turn
with `verity_knowledge record_decision`. This does not require a separate request
to save, but recognizing confirmation remains the model's responsibility. Ideas,
hypotheses and unapproved proposals are not decisions. Existing consent rules for
sensitive information still apply. This feature does not append to `overview.md`
or publish to Global.

Each decision is readable Markdown under Documents → decisions, with a stable ID,
confirmation session and user-message sequence, recording date and stated
rationale. The tool binds provenance to the calling project/session and checks
that the referenced message is a user prompt rather than a linked-peer message;
with authentication enabled it also requires user attribution. By default it uses
the latest delivered user prompt, including mid-turn steering. It does not verify
the meaning of that prompt. Only a successful durable-save receipt warrants a saved acknowledgement
and document link in chat. Errors must be reported rather than described as saves.

Before answering decision questions, agents use `lookup_decisions` to read full
records and cite them. Each new or resumed turn receives a bounded directory of
up to 20 decision references. Keyword lookup supports pagination and reformulated
queries; it is not semantic search. Existing source and Global file access remains
available, including extracted binary text under `.text`.

Confirmed replacements supply the previous decision ID and exact digest. The
previous record is retained; its status is computed as superseded by its successor.
Concurrent or stale replacements fail rather than overwrite an intervening change.
Repeated requests with the same session/request ID are idempotent if their contents
and confirmation reference match. Retries after a new turn must retain the original
`confirmationMessageSeq`. Manual document edits remain visible to lookup and change
the digest; altered or malformed records must be inspected before retrying a write.

Decision writes use the same project mutation lock as Documents publication and
Explorer edits. Session working copies refresh through the existing publication
flow; local pending edits remain protected by its conflict handling. Receipts refer
to canonical persisted Documents, which may precede a working-copy refresh.

Lookup scans at most 500 directory entries and reads records up to 24,000 bytes.
Responses return at most 10 records and normally about 32 KB per page (one complete
record may exceed that response target after JSON escaping). Invalid, oversized,
missing-predecessor or competing records produce explicit warnings and unresolved
statuses. An incomplete or invalid directory blocks new structured writes until
repaired; no valid decision is silently selected from partial evidence. Deleting
an entire decision removes it from discovery; deleting an ancestor leaves its
successor unresolved. The directory is derived from the Markdown files, not a
second database. Structured writes do not migrate existing free-form documents.
