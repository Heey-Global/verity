# ADR 0018 — Managed Knowledge Folders and Project Access

**Status:** Accepted · **Date:** 2026-09-15 · **Revised:** 2026-09-19

This revision replaces the original realm-and-namespace proposal with a
Verity-managed knowledge library and explicit project grants to folders. The
implementation follows this revised decision; see [Knowledge library](../knowledge.md)
for the user workflow. The filename stays unchanged to preserve existing links.

## Context

Durable knowledge must be available to agents without requiring the operator to
run an external knowledge service. A local Obsidian vault is not automatically
reachable from a Verity server; the original proposal assumed an MCP connection
without delivering the connection or synchronization path.

The desired workflow is to create and maintain knowledge in Verity, organize it in
folders and subfolders, and select which folders each project may read or also write. A project
may need several unrelated subtrees, such as `Company/Engineering` and
`General/Writing`. Requiring exactly one realm per project does not express this
choice naturally.

Existing project memory remains useful for short conventions and decisions.
Longer documents need durable storage, editing, discovery and retrieval on demand.
They must survive project Sandbox sleep, replacement and deletion.

## Decision

Verity will own a knowledge library of Markdown documents arranged in folders and
subfolders. Projects receive explicit `read` or `read_write` grants to one or more
folders.
A grant includes the selected folder's complete subtree. There is no realm,
additional space membership, or namespace required for this managed library.

The operator deliberately controls which knowledge can be combined in a project.
Names such as `Private` and `Company` are ordinary folders, not special isolation
classes. Granting both to one project is supported and knowingly makes both
available to its agents.

### D1 — One folder tree, with stable identities

Folders have stable identifiers, a name and an optional parent folder. Documents
have stable identifiers, a containing folder, a title and Markdown content.
Multiple top-level folders are supported; the library root is a navigation element,
not a grantable folder. Documents belong to a folder rather than the library root.

Folder names and paths are presentation, not authorization identifiers. Renaming a
folder does not invalidate its grants. Cycles and ambiguous sibling names are
rejected. Moving a folder changes inherited access and must be treated as an
access-policy mutation, not merely as a visual rearrangement.

Example:

```text
Knowledge
├── Private
│   ├── House
│   └── Finance
├── Company
│   ├── Product
│   └── Engineering
└── General
    └── Writing
```

### D2 — Project access is an explicit multi-selection of folders

Project Settings provides a folder-tree multi-select. A project can select zero,
one or many folders or subfolders anywhere in the library. Each selection has a
mode picker: **Read** or **Read & Write**. New selections default to `read`;
`read_write` is an explicit choice and includes read access.

- A selected folder grants its selected mode to itself and every descendant.
- New documents and subfolders inherit access from selected ancestors.
- No selection means no managed knowledge access.
- Grants combine by union; overlapping selections do not duplicate results.
  The stronger mode wins: `read_write` takes precedence over `read`.
- A read-only parent can have an explicitly writable child. A read-only child
  cannot restrict an inherited writable parent; the parent grant must be changed
  to read-only and write access granted to the intended subfolders instead.
- There are no deny rules or exceptions beneath a selected ancestor in the first
  version. To share only part of a tree, select those subfolders instead.
- The UI distinguishes direct selections from inherited access. Deselecting a
  child cannot remove access granted by a selected parent.
- The save view shows the resulting accessible subtrees, including inherited
  read/write modes, so the operator can review the effective grant.

Existing projects start with no folder grants. Project creation and GitHub sync
must not infer grants from repository names, organization membership or paths.
Deleting a project removes its grants, not shared knowledge.

### D3 — Verity stores and maintains the documents

The proposed initial storage is the existing Verity database: folder metadata,
Markdown document bodies, immutable document revisions and project-folder grants.
Knowledge is installation data, independent of repositories and Sandbox writable
layers. The database backup and restore procedure must include it.

The initial logical model is:

```text
knowledge_folders(id, parent_id, name, timestamps)
knowledge_documents(id, folder_id, title, current_revision_id, timestamps)
knowledge_document_revisions(id, document_id, body_markdown, author_identity, created_at)
project_knowledge_grants(project_id, folder_id, mode)
  mode: read | read_write
```

Foreign keys, unique grant pairs, validated modes and transactional writes enforce
consistency. Revision authorship distinguishes authenticated operator edits from
agent edits and records the originating project, session and turn for agent writes.
Updates use an expected revision so concurrent editors cannot silently overwrite
each other. Restoring an old version creates a new revision rather than rewriting
history. Documents are limited to 256 KiB of UTF-8 Markdown, imports and exports
to 100 documents and 2 MiB of Markdown per operation, and folder nesting to 16
levels with at most 1,000 folders. Document listings, search and revision history
are paginated in pages of at most 100 entries.

The knowledge library is accessible through a book icon in the app header, with
an accessible Knowledge label, independently of the current project. This entry
opens the library's top-level folder overview. Returning from the library restores
the previous screen. The library is not only a folder picker in Project Settings.
The operator can browse top-level folders, open nested folders, navigate back
using breadcrumbs or equivalent mobile navigation, and open Markdown documents
from the current folder's file list.

Opening a document shows its rendered Markdown with an explicit Edit action. The
editor exposes the Markdown source with a preview, Save and Cancel, and protection
against losing unsaved changes when navigating away. Saving updates the document
in place with a new revision; concurrent changes show a conflict rather than
silently overwriting another edit. Revision history and restoration are accessible
from the document view.

The UI supports creating folders and pages, editing Markdown, viewing revision
history, and importing and exporting Markdown with the folder structure preserved.
Individual files use `.md`; folder exports use a portable JSON bundle of relative
Markdown paths and bodies that can be reimported without an external service.
Project Settings provides an Open in Knowledge action for each folder grant so the
operator can jump directly to its contents and return to the project. Operator
library management uses operator authentication and is not limited by the current
project's agent grants; the UI keeps project access settings distinct from this
management view. These navigation and editing flows must work in the mobile app.
Imports validate paths and names and report collisions instead of overwriting
existing documents silently. Rendering must not execute embedded HTML or scripts.
Attachments, binary documents and a rich-text editor are outside the first version.

An external vault or MCP server is not required. Existing project MCP connections
remain independent; external knowledge integrations may be added later.

### D4 — Agents access authorized knowledge through server-mediated tools

All supported model backends (Claude, Codex and OpenCode) expose server-mediated
knowledge tools to list authorized folders, search documents, read a document, and
create or edit documents when authorized under D5. All three use the existing
per-turn gateway bearer (OpenCode admission is governed by ADR 0014 Amendment 4).
Knowledge grants remain independent of brokered-secret approvals. Knowledge
guidance is refreshed on each turn so newly granted folders are discoverable in
resumed sessions.
The server resolves the project
from a trusted session/turn identity and checks current grants on every operation.
A request-supplied project id or folder path cannot establish authority.

Search filters by authorization before computing result snippets, counts or
pagination. Listings, direct-id reads, revision reads and exports apply the same
policy. Unauthorized folder names, document titles, snippets and revision bodies
must not leak through navigation or error responses. Knowledge is not mounted
wholesale into project Sandboxes.

Agents receive only the selected document content needed for their work, with its
source and revision identified. Documents are external reference data and must not
be injected as standing system instructions. Search starts with bounded text
search; embeddings and semantic retrieval are not prerequisites.

Access events record the calling project, session and turn, operation, target,
revision where applicable, and allow/deny outcome. Audit metadata must not copy
document bodies. A read requires a durable access record before content is returned;
failure to record it denies the read. Successful writes commit their document
revision and audit event in the same transaction; audit failure rolls back the
write. Denied and conflicting write attempts are recorded without exposing content.

### D5 — Editing and memory have separate authority

A `read` grant permits discovery and reading only. A `read_write` grant additionally
permits agents to create Markdown documents in existing authorized folders and edit
existing documents' titles and bodies. It does not permit creating or renaming
folders, deleting or moving documents or folders, changing grants, or modifying
revision history. Those operations remain operator-only through the authenticated
UI/API. Imports that mutate hierarchy likewise remain operator-only.

The server checks the effective write mode on the destination folder for creation
and the document's current folder for edits. Authorization and the mutation are
transactionally ordered against grant changes and moves; a check performed only
when constructing tool descriptors is insufficient. Unknown or missing modes deny
access rather than falling back to write authority.

Every agent edit creates an attributed immutable revision and requires the expected
current revision. A stale edit fails with a conflict and must be reread and
reconciled; no blind overwrite or force-write bypass is exposed. Creation rejects
name collisions rather than converting them into edits.

The explicit write grant authorizes these changes without per-edit approval. Changes
become visible immediately to other projects with read access to the document.
The picker explains this shared effect, and the history shows who changed what.
The operator can restore a prior revision using the versioned UI workflow.

`project_settings.memory` and `verity-memory append` remain project-scoped. Short
project facts continue to enter fresh backend contexts through the existing memory
path. This revision introduces neither realm memory nor folder memory automatically
injected into every associated project.

A shared document can contain conventions, but sharing it does not turn its content
into a trusted instruction. Writable documents are an intentional cross-project
content channel: agents in other authorized projects may read those edits. This
must not become automatic system-prompt injection or permission to edit another
project's memory.

### D6 — Permission changes account for existing contexts

Downgrading effective access from `read_write` to `read` stops subsequent writes
without discarding a context that still has read access. Outstanding writes must
recheck authority at commit; a write ordered after the downgrade cannot succeed.
The UI evaluates the union of grants: removing one write grant is not a downgrade
if another ancestor still grants write access.

Revoking a grant prevents subsequent retrieval, but cannot make a model forget
content already read. The same issue arises when documents or subtrees move out
of a project's accessible tree or are deleted.

Mutations that reduce a project's accessible knowledge must therefore invalidate
its affected backend contexts before further dispatch. Old sessions remain
historical records and cannot resume or seed replacement contexts carrying the
removed knowledge. Scheduled Agent Loops need fresh sessions while retaining their
run history. A failed transition must not leave a resumable stale context with new
authority; transition state and retry/recovery behavior are required implementation
work.

Moves show the resulting access changes before confirmation. Stable ids preserve
direct grants to a moved folder; access inherited from its old parent disappears,
and access inherited from its new parent applies. Moving a document also changes
access to its revisions. The move and grant evaluation must be atomic with respect
to reads, writes and concurrent hierarchy mutations.

Removing a grant cannot erase content previously copied into a repository, another
document or a transcript. The UI must describe revocation as stopping future access
and continuation, not as deleting all past copies.

Folder grants alone also do not authorize cross-project transcript reads, handoffs
or dispatch. Those paths must not let a project obtain knowledge through a more
privileged session. Before shipping, their existing policies must be reviewed and
any unsafe agent-mediated transfer blocked unless an enforceable information-flow
rule exists. Equal or overlapping folder selections are not automatically a safe
transcript-sharing boundary, particularly after permissions change.

### D7 — Realms and their other responsibilities are removed from this proposal

This revision does not introduce `realms`, `project_settings.realm_id`,
`sessions.realm_id`, `realm_allowed_runtimes`, or `knowledge_namespaces`.
There is no single-select realm assignment alongside the folder multi-select.

Backend choice remains a project/session concern. Folder grants apply uniformly to
agents in the project and do not promise per-model isolation. New restrictions on
allowed backends, shared memory and general session-to-session information flow
need their own decisions rather than being inferred from folder names.

[ADR 0019](0019-learning-loop.md) still assumes realms, immutable realm provenance
and realm memory. Those assumptions are superseded by this revision. ADR 0019 must
be revised before implementation; a folder grant is not a replacement learning
scope, and it does not authorize scanning transcripts of other projects.

## Alternatives considered

- **Exactly one realm per project:** rejected for this knowledge workflow because
  projects need arbitrary combinations of folders and subfolders.
- **External knowledge stores only:** rejected as the required baseline because a
  local vault needs an additional connectivity or synchronization service.
- **Knowledge inside each Sandbox:** rejected because shared documents must survive
  Sandbox lifecycle changes and need centralized access enforcement.
- **Filesystem copies in every project:** rejected as the default because copies
  drift and cannot enforce current grants on subsequent reads.
- **Per-document grants and nested deny rules:** deferred; subtree grants with
  additive selection are easier to inspect and explain.
- **A complete Obsidian replacement:** out of scope. Graph views, plugins,
  collaborative live editing and semantic indexing are not needed for the initial
  managed Markdown library.

## Consequences

Verity now owns document storage, editing, version history, text search, import,
export and backup coverage. This deliberately reverses the original decision not
to store a knowledge corpus. The feature belongs to the self-hosted core and has
no dependency on a paid hosted service.

The UI needs a knowledge-library screen and a project folder-access picker.
Implementation spans the store, authenticated management routes, shared agent
read/write tools, session lifecycle handling and the mobile interface. Merely adding
a folder tree and filtering search results does not complete this decision.

## Required verification before shipping

- Direct and inherited grants, multiple selections, overlap and empty selections;
  read/write precedence, writable children and non-restricting read-only children.
- Read-only agents cannot create or edit documents; writable agents cannot move,
  delete, change hierarchy or grants, or mutate revision history.
- Write authorization is enforced across every backend, including direct-id calls,
  stale tool descriptors and grant downgrades or moves racing with commit.
- Agent writes produce attributed revisions and atomic audit events, become visible
  to authorized readers, and reject stale edits and creation collisions.
- New descendants, renamed folders, moves, cycle rejection and concurrent mutations.
- No unauthorized metadata or content through search, counts, listings, ids,
  revisions, exports or errors, across all supported knowledge gateway backends.
- Revocation and deletion racing with reads, active turns and scheduled loops;
  old contexts cannot resume or seed a replacement after access is removed.
- Agent-mediated cross-project paths cannot bypass knowledge authorization.
- The operator can open the library's root through the app-header book icon
  independently of the current project and return to the previous screen.
- The operator can browse nested folders, open
  documents, edit and preview Markdown, save or cancel, and inspect or restore
  revisions in the mobile app. Project folder links open the correct folder.
- Navigating away protects unsaved edits; save failures preserve the draft and
  concurrent edits reject stale revisions; restoration preserves history.
- Markdown rendering and imports reject executable content and path traversal.
- Knowledge and revisions survive Sandbox replacement, project deletion and a
  database backup/restore round trip; Markdown export preserves content and paths.

Security guards must be checked against deliberately broken authorization before
they are trusted, following the repository's testing instructions.

## Implementation and deferred work

The initial implementation serializes policy and content operations with a database
advisory transaction lock. Read-access reductions atomically record permanent
session invalidations and unbind Agent Loop sessions. Dispatch and agent tools
check this durable fence; cleanup stops backend contexts, retries on failure and
recovers after restart. Moves require a reviewed policy token and reject stale
previews.

Cross-project session tools exclude callers and targets with knowledge grants,
recorded knowledge exposure or invalidated contexts. Observation checks are repeated
after materializing the response, so a concurrent grant change cannot leak its
snapshot. This conservative policy can be refined separately.

Deferred work:


- A future retention policy for access records and document revisions. The initial
  version retains revisions while a document exists; explicit document or subtree
  deletion removes its revisions, while access audit metadata is retained.
- Text-search indexing and latency targets against a representative corpus.
- More permissive, explicit rules for agent-mediated cross-project information
  transfer that preserve knowledge provenance; folder overlap alone is insufficient.
- A revised scope and approval target for ADR 0019's Learning Loop.
