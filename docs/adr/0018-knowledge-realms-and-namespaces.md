# ADR 0018 — Managed Knowledge Folders and Project Access

**Status:** Accepted · **Date:** 2026-09-15 · **Revised:** 2026-09-20

This revision replaces the original realm-and-namespace proposal with a
Verity-managed knowledge library and explicit project grants to folders. The
managed Markdown library is implemented; see [Knowledge library](../knowledge.md)
for its current user workflow. The project-linked knowledge and Wiki amendment
(D8–D12) is implemented with the bounded format and runtime support documented
below. Where it changes the initial defaults or scope, that amendment takes
precedence. The filename stays unchanged to preserve existing links.

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

Existing project memory supplies short context automatically. The target design
retains that function as a curated project overview inside Knowledge rather than
a third user-maintained knowledge store (D11).
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

### D2 — Initial folder-grant model (default assignment amended by D8)

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

In the initial implementation, existing projects start with no folder grants. Project creation and GitHub sync
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
Attachments and binary documents were outside the initial version; D10
adds retained originals, bounded extraction, previews and portable exports. A rich-text editor remains outside scope.

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

### D5 — Editing and memory have separate authority (memory UX amended by D11)

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

In the shipped implementation, `project_settings.memory` and `verity-memory append`
remain project-scoped. D11 defines their migration, without dropping stored content. Short
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

### D8 — Every project has its own linked knowledge folder

The user-facing model has two destinations: **Files** for repository artifacts and
**Knowledge** for sources and reusable understanding. Knowledge is not a single
installation-wide synthesized Wiki. Each project owns a distinct knowledge folder:

```text
Knowledge
├── Project A
│   ├── Sources
│   └── Wiki
├── Project B
│   ├── Sources
│   └── Wiki
└── General
    ├── Sources
    └── Wiki
```

These are display names (for example, Sources / Wiki / General appear as
Quellen / Wiki / Allgemein in German). Stable project and folder identifiers, not
names or paths, establish the relationship. Existing unrelated folders named
General or matching a project name must never be silently adopted or exposed.

Creating a project, including a repository-free project, provisions its linked
root and exactly two standard child folders, Sources and Wiki, idempotently.
Concurrent creation, retries and GitHub synchronization must not create duplicate
roots or grants. Provisioning and publication of the project must be atomic or
use a recoverable state that prevents sessions from starting with partial defaults.

The project can read its whole linked folder and create/edit generated Markdown
in its Wiki. Sources and original files are read-only to agents. Do not grant
read_write to the linked root: under D2's union rules that would also make Sources
writable. Managed source roles additionally reject agent mutations even if an
extra grant would otherwise confer write access. Operator uploads and deliberate
source replacement are separate authenticated management operations.

The linked folder is a fixed association, visible in Project Settings, rather
than an optional extra grant. Removing or moving a managed root or standard child
cannot silently break it or broaden its audience. Ordinary moves/deletes must
reject such operations while linked; a future dedicated relocation workflow must
preserve role identities and validate the access impact. Project rename preserves
the binding even if a display-name collision prevents renaming the folder.
Deleting a project archives/unlinks its knowledge instead of deleting the sources,
Wiki or original assets. Historical authorship remains attributable; surviving
explicit grants from other projects are retained. Deleting the knowledge itself
requires a separate, explicit management action.

One installation-owned General folder is automatically readable by every project,
including existing and newly created projects. Its inherited read entry is shown
as always linked and cannot be unchecked in the additional-folder picker. This
is a deliberate public-to-all-projects boundary within the installation, not
public Internet access. General never receives project content automatically.
Agents have no default write access to General; publishing or maintaining its
Wiki is an explicit, separately authorized management workflow.

Project Settings therefore shows:

- This project's linked folder and its Sources/Wiki permissions.
- General, always linked for reading.
- Additional folder selections, with Read or Read & Write, initially empty.

No other project's folder is automatically accessible. Additional selections may
point to a whole project folder or an ordinary subtree. They preserve D2's union
semantics subject to managed source immutability and D9's derivation boundary.
Import from a project opens that project's Sources folder by default; the global
library allows the user to choose a destination explicitly. There is no automatic
classification into General based on a document's title or apparent generality.

### D9 — A Wiki is a scoped, sourced product of its own sources

The workflow follows the source/Wiki separation in
[Karpathy's LLM Wiki concept](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).
Sources retain the original material. Wiki contains generated summaries, topic
pages, links, an index and a chronological maintenance log. These are pages within
Wiki, not additional top-level storage categories the user must manage.

Uploading a source retains it and initiates supported technical extraction (D10).
It does not silently start a paid model turn or rewrite the Wiki. The explicit
**Incorporate into Wiki** action processes selected sources in the current area;
the user can review the resulting revisions and restore earlier versions. Batch
processing uses the same action and boundaries. Conversation answers enter the
Wiki only through an explicit save/incorporate request, not continuous harvesting
of every chat. Approved conversation material first becomes a source in the
selected area, with its provenance and destination sharing checked; the maintenance
job reads that source rather than inheriting the conversation context.
A **Check Wiki** action may identify stale claims, contradictions,
missing source references and broken links without searching unrelated projects.

Wiki maintenance runs in a fresh, dedicated context limited to the selected area's
sources, existing Wiki and approved maintenance rules. It must not reuse the
calling conversation's context, memory or unrelated grants. Source text and
extracted content remain untrusted data. Maintenance rules belong to an approved
configuration; an uploaded AGENTS.md is not automatically such a configuration.
All supported model backends use the same server-enforced boundaries.

Each generated page records source identities and revisions, and page/slide
references where available. Distinguish explicit source statements from inferred
conclusions; preserve unresolved contradictions rather than asserting consensus.
Updating a source marks dependent pages stale and offers reprocessing; it does not
pretend the old synthesis is current. Each successful page change uses the
existing expected-revision and attribution rules. Jobs record partial completion,
failures and their input revisions, so retries do not duplicate output or silently
accept changed inputs. A log entry must not claim that a failed batch completed.

Additional reading rights allow an ordinary project session to consult external
knowledge. They do not, by themselves, authorize publishing that knowledge into
its own Wiki or General. A summary is not declassified by paraphrasing it.

This requires enforcement beyond the existing folder ACLs. Managed Wiki writes
must account for server-recorded context exposure and source provenance, including
transitive derived sources; model-supplied citations alone are not proof. The
ordinary create/edit tool cannot be a bypass around the maintenance workflow.
If the service cannot establish an allowed destination for a context's source
material, it must refuse the managed Wiki write and offer a fresh scoped job.
Recheck source rights and destination audience at commit and before resuming jobs.

Sharing or widening access to a derived page/subtree must also examine dependency
boundaries; later moves or new grants must not expose restricted source content
through already-generated pages. Broader publication needs an explicit management
decision naming the destination and content being shared. Removing source access
cannot erase past copies, as D6 explains. This design governs managed knowledge
operations; it does not claim complete information-flow control over arbitrary
agent output or files already copied into a repository.

### D10 — Original files are first-class sources

A user can upload supported non-Markdown files directly into Sources: PDFs,
PNG/JPEG images, SVG logos, and modern Office documents such as PowerPoint (.pptx),
Word (.docx) and Excel (.xlsx). Retain the exact original bytes, filename, validated
media type, size, digest and revision identity. No manual Markdown conversion is
required. Replacing a source creates a new immutable source revision; old citations
must still identify the original version they refer to.

Extraction produces searchable text and structural metadata linked to that source
revision. PDF pages, presentation slides and spreadsheet sheets retain locators;
images/logos retain original-file references and, when available, previews.
An agent using a logo must be able to retrieve the real file rather than recreate
it from a prose description. Visual tasks must be able to inspect relevant images,
pages or slides through a compatible tool/model path. Text extraction alone must
not claim to preserve typography, layout, diagrams or colors. If visual processing
is unavailable, show that limitation and offer the original; do not invent a
successful interpretation.

Show explicit processing states: pending, processing, ready, unsupported and
failed, with retry where applicable. A file with no extracted text is not
necessarily empty: a scanned PDF may need OCR. Password-protected, malformed or
unsupported documents remain downloadable originals with an honest processing
status. OCR and visual interpretation must be distinguished from direct extraction.
Original retention must not depend on model availability or extraction success.

Use bounded, isolated processing with byte, decompressed-size, page/sheet/pixel,
time and concurrency limits. Validate media types and containers; do not execute
Office macros, embedded scripts, external links or uploaded SVG as active content.
PDF/Office preview conversion and model interpretation are separate capabilities,
not implied by accepting a file extension. Exact converter dependencies and
resource limits must be selected and verified during implementation.

Original downloads, text extraction, thumbnails, page previews, search snippets,
exports and model reads all inherit the source's folder authorization and audit
requirements. An unguarded content-hash URL or long-lived public preview link must
not bypass current grants. Derived representations cannot leak metadata for denied
sources. Source availability/revocation is checked when a queued job executes,
not only when the file was uploaded.

Persist originals independently of Sandbox lifetime, preferably with the existing
database-backed knowledge identity and backup boundary. Metadata, immutable source
versions, extraction records and Wiki provenance must survive backup/restore as
one consistent dataset. A complete portable export/import preserves originals,
paths and source relationships; a Markdown-only export must be labeled as such.
Binary size limits are separate from the current 256 KiB Markdown / 2 MiB bundle
limits. No process may silently truncate a binary to fit a text limit.

### D11 — Project overview replaces a separate Memory destination

Keep the useful capability of short automatically supplied project context, while
removing the need to maintain a second factual knowledge store in a Memory tab.
A project may pin a short, curated **Project overview** page inside its own Wiki.
It appears within Knowledge and is explicitly marked **Always consider**. There
is no third standard folder for Memory and no automatically synthesized global
memory spanning projects.

The overview contains the project's purpose, important terms, constraints and
links to authoritative documents. It does not accumulate transcripts or every
conversation recap. Only the project's approved overview revision is injected
when a backend context starts, within a bounded context budget; the rest of the
Wiki is retrieved on demand. Changes show when they will take effect and must
respect D6 if access is withdrawn. Pinning does not override folder permissions.

Wiki generation and ordinary write grants cannot silently change an approved
standing-context revision. Agents may propose an overview update, but explicit
user approval selects what becomes always-present context. Knowledge reference
content must not be promoted to executable policy or broader tool authority.
Repository work rules such as build/test commands remain in AGENTS.md; a shared
Wiki document does not replace those rules or system instructions.

Migrate existing project memory without loss. Preserve its full original value and
offer classification into a project overview, factual Wiki pages or repository
rules; do not silently rewrite/delete it. During migration maintain a single
active context source, with explicit activation and rollback, rather than injecting
both legacy memory and a duplicate overview. Keep verity-memory append compatible
until replacement behavior is defined: it must not report success while discarding
notes, bypass overview approval or keep an invisible second active memory store.

### D12 — Rollout and simple user workflow

The target default is: create project, receive linked Sources/Wiki and General,
upload material, then optionally incorporate it into the Wiki. Additional access
is the exceptional setup step, not a prerequisite for the first useful session.
Existing arbitrary folder trees remain valid; the change does not mandate moving
all repository docs or restructuring the entire installation.

For existing projects, create missing managed folders and bindings idempotently,
preserving current explicit grants. New General must be empty unless the user
explicitly chooses and confirms existing material to make readable by every
project. Never migrate existing private content into General automatically.
Existing Markdown documents, memory and transcripts retain their content and
history. Migration and backup/restore must preserve the fixed folder identities,
not reconstruct ownership from names.

Repository files remain the home of code, tests, run instructions, version-bound
specifications and accepted technical ADRs. Meetings and research normally become
knowledge sources; synthesis belongs in the area's Wiki. For example, a meeting
transcript remains a source, its topic summary belongs in Wiki, and a resulting
accepted architecture decision may be written to the repository with provenance.
Use one authoritative location per artifact rather than synchronized full copies.
A project without a repository still gets the same knowledge workflow.

The implementation extends the original Markdown baseline in these layers:

1. Provision linked project folders and General, migrate safely, and show fixed
   versus additional access in the existing compact explorer and settings.
2. Add original-source storage, permission-aware retrieval, previews/extraction,
   explicit processing states and complete backup/export coverage.
3. Add scoped, auditable Wiki maintenance with derivation-aware write/sharing
   enforcement. Do not ship automatic synthesis with prompt-only isolation.
4. Integrate the approved project overview and migrate the legacy Memory UX
   without dropping notes or weakening authority boundaries.

No upload alone starts background Wiki generation, no project automatically reads
another project's knowledge, and no generated insight is automatically published
to General. Automatic maintenance schedules, broader publishing workflows and
semantic search can be decided later without adding another knowledge destination.

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

For D8–D12, additionally verify:

- Atomic/idempotent project provisioning, rename, delete/archive and migration;
  no accidental adoption of same-named folders or exposure through General.
- Fixed own-folder/General access and optional extras, including attempts to grant
  write access to managed Sources through an ancestor.
- Wiki jobs cannot read unrelated project contexts or publish through ordinary
  tools after reading restricted material; source revocation and sharing changes
  account for transitive derivatives and queued/in-flight jobs.
- Original bytes and source revisions round-trip through backup and complete
  export/import; denied access also covers originals, previews and extracted text.
- Malformed, oversized, compressed, encrypted, scanned and unsupported files have
  bounded processing and truthful status; no active uploaded content executes.
- Wiki output cites exact source revisions, flags stale inputs, preserves
  conflicts, retries safely and attributes each change.
- Overview activation is explicit, bounded, permission-aware and cannot be
  modified by ordinary Wiki writes; memory migration has no loss or double injection.

The shipped Markdown baseline also requires:

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

Project creation and migration now provision stable managed spaces and fixed
read access to General. Agent writes to Sources and ordinary-session writes to
managed Wiki pages are rejected. Explicit project Wiki jobs pin source revisions,
record transitive provenance, restrict sharing, expose stale derived pages and
run without inherited conversation, overview, extra grants or project MCP servers.
Public follow-up prompts cannot steer or resume these maintenance sessions.
A trusted isolation flag reaches the supervisor and spawn broker, both of which
must advertise support. Jobs use fresh backend homes and Linux Landlock ABI 3
read/write confinement; legacy loopback execution and old images are refused.
No project Docker group, external MCP proxy or trusted CLI execution is attached.
The common system executable roots remain readable; custom toolchains outside
those roots fail closed rather than granting access to a whole user home.
Interrupted jobs are failed at startup rather than replayed. Job failures retain
partial revisions for review; a retry starts a new session.

The approved overview is an explicit revision snapshot. Legacy notes remain
available behind migration controls; approving an overview replaces their prompt
injection and legacy append requests return a conflict instead of silently saving
notes that the agent will not receive.

Original bytes and historical revisions are part of the database backup. Portable
source bundles contain current originals, extraction and previews; they are not
full revision-history archives. Supported PDF and image previews are rasterized;
Office processing extracts text with locators, not rendered slide/page layout.
OCR and legacy binary Office conversion are not implemented. Failures and unsupported
formats preserve the original and expose a truthful processing state.

General is automatically readable, but project Wiki jobs cannot synthesize into
it. Its contents can be curated through authenticated library management. A model
workflow for publishing or maintaining General remains separate from project jobs.

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
