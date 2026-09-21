# ADR 0022 — Knowledge is a project folder agents can read

**Status:** Proposed · **Date:** 2026-09-21
**Supersedes:** [ADR 0018](0018-knowledge-realms-and-namespaces.md) (managed knowledge
library: folder tree, grants, Sources / Wiki, maintenance jobs, curated overview approval).
**Related:** [`positioning-and-navigation.md`](../positioning-and-navigation.md) (the
positioning this follows from), [ADR 0009](0009-google-drive-sources.md) (Drive sources feed
the same folder), [ADR 0008 — per-project memory](0008-per-project-agent-memory.md)
(`verity-memory` keeps working, writing to `overview.md`).

## Context

ADR 0018 built a Verity-managed knowledge library: a folder tree with stable IDs, per-project
read / read-write grants, managed *Sources* and *Wiki* folders per project plus a shared
*General* root, LLM maintenance jobs that compile Sources into cited Wiki pages with an index
and a maintenance log, and a curated project overview with an approval step. It is, in
effect, the "LLM wiki" pattern: raw sources immutable, an LLM-maintained page layer between
the operator and the sources, and a human who browses the result.

The positioning workshop (2026-09-21) set a different requirement for the operator side:

> Knowledge is not something I look at. Transcripts, PDFs, offers, annual reports go in;
> agents find what is relevant; I see a short per-project overview and can delete or
> correct. I do not want to click through a wiki.

Against that requirement the library carries UI and concepts nobody will use — a Knowledge
screen with a folder tree, a *General* root explainable only by its rule, grants configured
as a checkbox tree, *Incorporate into Wiki* and *Check Wiki* actions — while the one thing an
agent needs most is weak: search is `ILIKE` over whole documents
(`packages/store/src/knowledge.ts:1322`), so a 180-page PDF is found whole or not at all.

Two more facts shaped the decision:

- The chat already has the two entry points the operator wants to keep: a per-message
  *save to Project Knowledge* action and a *save attachments to knowledge* checkbox on send
  (`apps/mobile/app/session/[id].tsx:481`, `:2165`; `saveSessionKnowledge` in
  `packages/mobile/src/api.ts:1883`).
- Sandboxes already receive read-only host binds (`provisioner.ts:1036`, `:1663`), and the
  session explorer already lists and uploads files for a directory (`session-file-routes.ts`,
  `server.ts:7195`). A folder is a surface the app and the agent both understand.

## Decision

**A project's knowledge is a folder on the server, mounted read-only into the project's
sandboxes and shown in the session explorer. Agents read it like any directory. Nothing
else exists on the operator side: no Knowledge screen, no folder tree, no grants, no Wiki.
A retrieval index over the folder is a later stage, not part of this decision's first
build.**

### D1 — One folder per project, one shared folder

```
<VERITY_DATA>/knowledge/
├── shared/                       readable by every project
└── <projectId>/
    ├── overview.md               the project's short memory (D5)
    ├── meetings/                 recordings + transcripts
    ├── imports/                  files kept from chat, share sheet, Drive
    ├── notes/                    saved chat texts, spoken notes, corrections
    └── .text/                    extracted text per file (hidden; what agents read for binaries)
```

The subfolders are assigned by the entry point (D3), never chosen by the operator; they
exist so the explorer reads at a glance and an agent can `ls knowledge/meetings`. `.text/`
holds the machine-readable form of files an agent cannot read directly — a PDF's text with
page markers, a recording's transcript with timestamps — mirrored under the same relative
path (`.text/imports/Angebot.pdf.md`). It is hidden in the explorer so every file does not
appear twice; the explorer's file preview shows the extracted text on the file itself.

The folder is the source of truth. Verity's database holds nothing an operator would need
to restore (the later retrieval index, D4, is derived). Deleting a project keeps its folder as an
unlinked archive, as ADR 0018 did for the library.

**Scope is the folder.** A project's sandboxes see `<projectId>/` and `shared/`; nothing
else is mounted. There is no per-folder grant; moving a file between a project folder and
`shared/` is the only scope change and is done in the explorer.

### D2 — Sandbox mount and explorer root

- Every sandbox of the project gets `<projectId>/` at `/knowledge` and `shared/` at
  `/knowledge/shared`, both **read-only** binds (same mechanism as the agent-seed toolkit).
  Agents `ls`, `grep` and `cat` it like any directory; citations are paths with locators:
  `knowledge/meetings/2026-09-21-kickoff.md · 14:32`.
- The session explorer shows two pinned roots above the worktree: **📚 Knowledge** and
  **📚 Shared**. `session-file-routes` resolves the reserved top-level names `knowledge/`
  and `shared/` to the project folders instead of the worktree, with the same realpath
  guards. Listing hides `.text/`. Upload into these roots writes the file and triggers
  extraction (D4); delete removes the file and its extracted text. Rename and move are file
  operations.
- For a `local` project (no repository) the explorer shows only the two knowledge roots.
  Nothing is special-cased.

### D3 — Entry points (operator side; no other UI changes)

| Entry | Behaviour | Status |
| --- | --- | --- |
| Attachment checkbox on send | Unchanged UI. Checked → file copied to `imports/`, else it stays in the worktree for the session. **Default unchecked.** | exists |
| Per-message *save to knowledge* | Unchanged UI. Text saved as `notes/<date>-<slug>.md`. | exists |
| Meeting recording from the composer | **Kept automatically** in `meetings/` (audio + transcript with timestamps). The session receives the path. No longer written to the repository's `docs/meetings/`. | change |
| Google Drive sources (ADR 0009) | Land in `imports/` like any file. | re-point |
| Explorer upload into a knowledge root | Direct file drop for iPad / desktop. | new, small |

Removed from the app: the Knowledge screen (`apps/mobile/app/knowledge.tsx`), its components
(`components/knowledge/*` except the Markdown renderer if reused), the header book icon and
the split-view Knowledge action (`_layout.tsx`, `session/[id].tsx:3161`), and the API
methods for folders, grants, wiki jobs, overview approval and source bundles.

Also removed, because each belongs to the Wiki model:

- **Project screen → "Knowledge" tab** (`project/[id].tsx:429`, internally `memory`): the
  approved-overview panel with Wiki job status and the *Incorporate into Wiki* / *Check
  Wiki* actions (`ProjectKnowledge`), the legacy **Memory** text field kept "for migration"
  (`MemorySection`, `:2967`), and the per-folder grant tree (`ProjectKnowledgeGrants`).
  The tab goes; the project screen keeps *Dev Server* and *Automations*. Overview and memory
  live in `overview.md` (D5); grants have no successor (D1).
- **Server settings → "Knowledge"** (`settings/knowledge.tsx`): the one server-wide setting
  it holds is the model Wiki maintenance jobs run on. It goes with the jobs. Extraction
  needs no model; transcription keeps its own backend setting.

### D4 — Extraction now, retrieval later

**Now.** Every file that lands in the folder is extracted once, idempotent on
`(path, size, mtime, sha256)`, by the existing source-processing worker
(`knowledge-source-processing.ts`, unchanged in bounds and sandboxing): PDF → text with
page markers, Office → text with slide / sheet locators, audio → transcript with timestamps
and speakers, into `.text/<path>.md`. That is all. Agents find material the way they find
code today — `ls` and `grep` over `/knowledge` and `/knowledge/.text` — and cite paths with
locators: `knowledge/meetings/2026-09-21-kickoff.md · 14:32`. For a folder of dozens of
files that is sufficient; it is also exactly what the operator sees.

The current agent knowledge tool (`list / read / search / read_original / create / edit`,
`ILIKE` search over whole documents) is retired with the library; the mount replaces it.

**Later (stage 5).** When folders grow past what `grep` serves well, a retrieval index is
added *on top* of the same files: chunk `.text/` along structure into 400–800-token pieces
with locators, index them in Postgres (`tsvector` full-text always; a `pgvector` embedding
when an embedding backend is configured — pglite ships both, no second service), and give
agents `search(query)` → chunks with head and locator, plus `open(path, locator)`. A
generated **head** per file (summary, participants, decisions, open points — one bounded
model call) belongs to that stage too. Nothing in the folder layout changes for it.

### D5 — `overview.md` is the project's memory

Today the "remember this" text an agent appends through the sandbox command
`verity-memory` (ADR 0008, broker at `project-memory-route.ts`) is stored as a knowledge
document that the operator must **approve** in the app before it becomes visible
(`approveProjectOverview`, `overview_visible`), after which the broker rejects further
legacy appends. That approval step is curation, and it goes.

`overview.md` replaces both: it is a short Markdown file (target ≤ 1.5k tokens) that Verity
injects into every new session's system prompt, exactly where the memory text went before.

- `verity-memory append` keeps working and appends to `overview.md`. It stays the **only**
  way an agent writes into the knowledge folder: the mount is read-only, and the broker's
  append-only contract with a size cap (`PROJECT_MEMORY_MAX_CHARS`) is the right boundary —
  a writable `overview.md` in the mount would let an agent, or injected content it read,
  rewrite the file freely.
- Once heads exist (D4, later stage), ingest may append one line per new file —
  "2026-09-21 kickoff: decided X; open Y". Until then nothing is automatic.
- The operator corrects it in the explorer (edit) or by voice ("Müller ist nicht mehr
  Ansprechpartner"): the spoken correction is saved to `notes/` and the affected line is
  replaced. The old line stays recoverable through the note.
- No approval flow. The file is the state.

### D6 — Migration from the ADR 0018 library

One-time, on upgrade, per existing folder:

| Library item | Becomes |
| --- | --- |
| Managed project *Sources* documents and originals | `<projectId>/imports/<title or file name>` (latest revision) |
| Managed project *Wiki* pages | `<projectId>/notes/wiki/<title>.md` — kept as plain notes, indexed like any file, never regenerated |
| Curated project overview | `<projectId>/overview.md` |
| *General* folder tree | `shared/<folder path>/…` |
| Any other top-level folder and its grants | `shared/<folder path>/…` (grants are dropped; the operator moves anything private out of `shared/` before or after — the migration report lists what it placed there) |
| Meeting transcripts under `docs/meetings/` in repositories | left in place; new recordings go to `meetings/` |

Older revisions are not migrated. The database tables of the library are dropped after the
migration has written and verified the files.

### D7 — What is deliberately not built

- **No page layer.** Cross-document synthesis is the agent's job at question time, with
  `search` results as input. If that proves unreliable for recurring questions, a background
  job may write a per-topic summary *as another file* under `notes/` that the normal index
  finds — not a separate system.
- **No fact store with validity dates, no entity resolution.** A worthwhile upgrade only if
  "which contact is current?" errors occur in practice.
- **No revision history per file.** The folder may be a git repository if that is wanted
  later; nothing here prevents it.
- **No per-folder grants.** Scope by mount is the whole access model and is explainable in
  one sentence.
- **No index in the first build.** `grep` over a mounted folder is the retrieval; the index
  is added when folders outgrow it, on the same files.

## Consequences

**Positive**

- The operator's knowledge surface is the explorer, the attachment checkbox and the
  per-message save — all of which exist. The Knowledge screen, folder tree, grants, Wiki
  jobs and their UI are deleted (`packages/server/src/knowledge-*.ts` and
  `packages/store/src/knowledge*.ts` total ~6.9k lines before tests; a large part goes).
- Agents get a plain directory they can grep, with extracted text for binaries — the same
  affordance they have for code — instead of a tool with whole-document `ILIKE`.
- Projects without a repository have full knowledge with no special path.
- "What you see is what the agent sees" holds literally: same files, same paths.

**Negative**

- Loss of per-document revisions and of fine-grained grants. Accepted; both were built for
  a curation workflow the operator has rejected.
- The `shared/` folder is a coarser privacy boundary than ADR 0018's grants. The migration
  report and the explorer make its contents visible; anything private belongs in a project
  folder that is not shared.
- Without an index, a very large folder makes agents slow rather than wrong; that is the
  signal to build stage 5.
- Wiki-job isolation work (Landlock-bounded maintenance runtimes) becomes unused. The
  runtime isolation itself stays available for other jobs.

**Neutral**

- `docs/knowledge.md` is rewritten to describe the folder, the checkbox and the save
  action when this lands.
- The knowledge tool's provenance rules stay: search results are reference material, not
  instructions.

## Build order

1. Folder layout, sandbox binds, explorer roots (list / upload / delete / move), hidden
   `.text/`, extraction into it.
2. Re-point existing entry points: attachment checkbox → `imports/`, message save →
   `notes/`, meeting recordings → `meetings/` (audio + transcript), Drive → `imports/`.
3. `overview.md`: injection at session start, `verity-memory` appends to it, approval flow
   removed.
4. Remove the Knowledge screen, book icon, grants screen, wiki jobs, knowledge tool and
   routes; migration (D6); rewrite `docs/knowledge.md`.
5. Later: retrieval index (chunks, full-text, embeddings when a backend exists), heads,
   agent `search` / `open`.

## Open questions

- **Flat or structured folder.** `meetings/ · imports/ · notes/` are automatic and cost the
  operator nothing; a flat folder with dated file names would work as well. Decide at
  implementation; the ADR does not depend on it.
- **Stage-5 embedding backend.** Reuse the transcription backend configuration
  (OpenAI-compatible endpoint) with an embeddings model, or a dedicated setting? Default:
  same endpoint, separate model name.
- **Explorer edit of `overview.md`.** The explorer previews files today and does not edit
  them; an inline editor for exactly this one file, or voice-only correction, is a UI
  decision deferred to implementation.
