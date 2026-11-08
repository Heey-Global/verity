# Knowledge folders

Each project has a durable Knowledge folder on the Verity server. Open the
project settings and choose **Project knowledge** for Decisions, Wiki and Raw Sources,
or open a session's file explorer for project files. Shared reference material lives
under **Settings > Shared knowledge**. Replacing a Sandbox does not remove these files.

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
file tools such as `ls`, `grep`, and `cat`; there is no separate Knowledge tool.
The built-in `wiki-maintain` Skill describes how agents set up and extend the Wiki
(see [Wiki setup and change log](#wiki-setup-and-change-log)).

Verity Control receives the Knowledge folder of its built-in `verity-control` project,
plus Global knowledge. Control retains a writable `/knowledge/insights` mount. It does not mount other projects'
Knowledge. `verity-memory append` saves explicitly requested notes to Control's own
project overview through its authenticated turn broker. Managed updates reconcile
these mounts; legacy Compose deployments receive them when the updated stack is applied.

Agents change Wiki content only when the user explicitly asks or confirms the concrete
change. When their work produces a durable, reusable conclusion grounded in project
sources, they offer it as a Wiki change and ask. They prefer updating an existing
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

Upload, delete, and move project files from the session explorer. Shared browsing
is central under Settings; it is absent from project and session tabs. Publishing
project material to Shared requires explicit approval. The hidden extracted text
follows its source file when supported file operations move it.

Agents publish a finished project insight to `shared/insights/` with the
`verity_knowledge` `publish_shared` operation only when explicitly asked to make it
shared, global, or available to every project. Existing shared insights require their
current digest before replacement, so concurrent edits are not silently lost. Original
sources remain read-only to agents.

Knowledge folders are separate from repositories. Code, tests, build
instructions, and versioned architecture decisions still belong in the project
repository. New meeting recordings are not written to `docs/meetings/`.

Wiki is the user-facing name for project Documents. There is no folder grant
screen, overview approval, or Knowledge model setting. Retrieval indexing and semantic search may be added later on top of the
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

The session explorer can edit UTF-8 text files up to 1 MB in Code and Wiki.
The central Shared browser and direct Project knowledge browser support revision-checked
Wiki text edits and original downloads; project edits require management access.
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


## Shared knowledge in the app

Project settings > Project knowledge opens Decisions (`insights/decisions/`), Wiki (`insights/`) and Raw Sources (`sources/`) without requiring a session. Project context remains separately editable through Instructions and Memory; Instructions also show the read-only `AGENTS.md` of connected repositories (see [project repositories](project-collaboration.md#instructions-across-repositories)).

Settings > Shared knowledge is the central browser for cross-project reference material. Personal Instructions and Memory remain separate under Settings > Personal context; project Instructions and Memory remain in project settings. Project and session file browsers show project files only. Existing Shared file links open the central Settings view.

Active users can browse and download Shared files without selecting a project or session. Administrators can edit supported text files under Shared Wiki (`insights/`); writes require the version last read so concurrent changes cannot silently overwrite one another. Original sources and derived files remain protected in this editor. Publishing from a project continues to use the existing explicit publication approval.

This navigation change does not move existing files, convert shared material into private context, or remove agent read access to `/knowledge/shared`.

## Wiki setup and change log

The project Wiki explains itself when it has no start page. An empty Wiki offers
**Set up Wiki**; a Wiki with pages but without `insights/index.md` offers **Create
overview** above its page list. Both open a project session with a prepared request:
the agent asks what the project is for and what matters now, proposes topics with
the existing pages they cover, and writes nothing until the user confirms. It then
writes `index.md`, `wiki-conventions.md` (the project's own Wiki rules) and a
`setup` entry in `log.md`. **How the Wiki works**, behind the ⓘ in the Wiki's
header, explains the roles and links the conventions and the change log;
**Rebuild overview…** runs the same setup again.

`log.md` is append-only. An entry is a heading `## [YYYY-MM-DD] kind | Title` (UTC date), with
kind `setup`, `ingest`, `chat`, `merge` or `lint`, followed by links to the pages it
changed and the sources it used. The Wiki catalog gives every page the latest entry
that links to it, so **Recently updated** names where a change came from; pages the
log never names fall back to their file age.

## Wiki maintenance occasions

The server notes what a project's Wiki may need to reflect, once per item, in
`wiki_occasions`: an imported or uploaded source, a filed meeting transcript, a
recorded decision, a changed chat day from a connected room, a merged pull request
of a project session, and a session deleted as done. Noting never fails the event
that caused it.

Deleting a session can keep its conversation for the Wiki (`DELETE
/sessions/:id?wiki=true`). The server then stores the plain messages of the user and
Verity, without tool output, with the occasion and deletes the session as usual.
Only the most recent 256 KiB of the conversation is read and kept, and a deletion
waits at most five seconds for it; a slower store may still record it afterwards. Nothing is copied into the project's knowledge; reading the occasion in a
maintenance run drops the stored text. Without `wiki=true`, which older clients
never send, nothing is kept and an earlier occasion of that session is forgotten.
A merged pull request is recorded once even when the status cache reports it again
after a restart; a chat day or re-filed meeting opens its occasion again. A
maintenance run closes only the version it read, so an occasion reopened while the
run works stays open with its new text. Until a maintenance run reads them, open
occasions and their kept text remain stored, also while a deleted project is
hidden; they are removed only with the project's database row.

## Wiki maintenance runs

A run starts only when something new happened, never on a fixed schedule. Every
15 minutes the server looks at projects with open occasions and starts a run when
all of these hold:

- The project's Wiki is set up (`insights/index.md` exists while the knowledge volume is present). Without it no run
  starts, and open occasions older than 30 days are discarded.
- The project is active or sleeping, and not deleted. A paused, failed or still
  provisioning project is never started for its Wiki; Verity Control has none.
- The newest occasion is at least 2 hours old, so a burst settles into one run.
- The last run started at least 20 hours ago.
- A sleeping project is woken only when its oldest occasion is 3 days old or 20
  are open; otherwise its occasions wait.
- No session of the project is working.

The run is a turn in the project's quiet maintenance session, created on first
use with the project's default model and recorded in `wiki_maintenance` together
with the time the last run started. The slot is claimed before the run starts, so
two server generations never both start one; a run that could not start gives the
slot back. The session appears in no session list and sends no push
notification; when it is gone, the next run creates a new
one. Its fixed assignment points the agent to the `wiki-maintain` Skill, which
reads the occasions with `verity_wiki_read_occasions` (a list, then each kept text
in pages of 40,000 characters), proposes changes with `verity_wiki_propose` in
mode `maintenance` and closes what it read with `verity_wiki_close_occasions`.
Only the maintenance session may read or close occasions.

Because the run reads untrusted text with nobody watching, its posture belongs to
the session, not to the request: every turn of the maintenance session runs with
the same read-only isolation as planning (read-only file system, no Docker) and
without shell, web, subagent or editing tools, also when it is recovered or queued.
The gateway then refuses every external tool except the occasion operations and
`propose_wiki`, and the project's connected MCP servers refuse the session. The results appear as
proposals to review on the Wiki; the run itself changes no page.

## Wiki proposals

Agents that have no confirmation for a concrete Wiki change propose it with
`verity_wiki_propose`: mode `inline` at the end of an answer in chat (one per
answer), mode `maintenance` in maintenance runs. A proposal names its sources, a
title for the change log, and for each page its complete new Markdown and a
one-line summary. Pages are Markdown files in the Wiki; `log.md` and decision
records cannot be proposed.

Proposals are stored as files under `<data root>/wiki-proposals/<project>/`, beside
the project's knowledge rather than in it, so agents never read an undecided change
as knowledge. The server records each page's version when the proposal is made. A
change identical to one already proposed, applied or rejected, or to the page as
it is, is skipped; at most 50 proposals per project can wait for review.

`GET /projects/:id/knowledge/proposals` lists open proposals with each page's path,
summary and whether it changed since the proposal (`stale`);
`GET …/proposals/:proposalId` adds the proposed and the current text. Reading
requires read access to the project. `POST …/proposals/:proposalId/apply` and `…/reject`
decide all pending pages or those named in `paths` and require the Wiki's edit
access (project `manage`). Applying writes through the Wiki's versioned editor
path, so a page edited meanwhile is reported as stale and left unchanged, a page
that cannot be written is reported as failed and stays pending, and applying adds
one `log.md` entry with the applied pages and the sources; when that entry cannot
be written, the apply still succeeds and returns a warning. A decided change keeps
only a fingerprint of its text; the Wiki's own version history holds what was
applied. Like the project's knowledge folder, proposals stay on disk when a project is
deleted, which only hides it; while it is hidden they can be neither listed nor
decided.
