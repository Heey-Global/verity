# ADR 0022 — Filesystem-backed project knowledge

**Status:** Proposed · **Date:** 2026-09-21

**Supersedes:** [ADR 0018](0018-knowledge-realms-and-namespaces.md)

**Related:** [ADR 0008](0008-per-project-agent-memory.md), [ADR 0009](0009-google-drive-sources.md)

## Context

ADR 0018 introduced a managed knowledge library with database-backed folders, Sources and
Wiki documents, grants, maintenance jobs, and an approved project overview. That model
requires a separate application surface and gives sandboxed agents access through a custom
tool.

Verity already has two simpler primitives that cover the required behavior:

- the session explorer can browse and transfer files; and
- project sandboxes can receive read-only mounts.

A filesystem-backed model lets the application and sandboxed agents use the same durable
artifacts. Binary sources still need derived text so agents can inspect them without
special-purpose document APIs.

## Decision

Knowledge is stored as files below the Verity data root. Each project has a private folder,
and one separate folder contains explicitly shared material.

```text
<VERITY_DATA>/knowledge/
├── shared/
└── <projectId>/
    ├── overview.md
    ├── meetings/
    ├── imports/
    ├── notes/
    ├── shared/
    └── .text/
```

The project folder is mounted read-only at `/knowledge` in that project's sandboxes. The
shared folder is mounted at `/knowledge/shared`. A sandbox cannot write either mount.

The existing database-backed library remains available internally as a migration and
compatibility source during the transition. New content described by this ADR is written to
the filesystem.

### Explorer roots

The session explorer exposes three roots:

- `worktree`, preserving the existing behavior;
- `knowledge`, resolving to the session project's private knowledge folder; and
- `shared`, resolving to the shared knowledge folder.

Knowledge roots support listing, upload, preview, download, deletion, and moves between the
private and shared roots. Worktree deletion through these new endpoints is prohibited.
Path resolution retains the existing containment, realpath, symlink, and no-overwrite
guards. The `.text` directory and the nested `shared` mount point are managed paths and are
not directly mutable through the explorer.

### Entry points

Content is placed according to its source:

| Source | Destination |
| --- | --- |
| Saved chat text | `notes/` |
| Saved chat attachment | `imports/` |
| Google Drive import | `imports/` |
| Meeting audio and transcript | `meetings/` |
| Explorer upload | selected private or shared directory |

Saving chat attachments remains opt-in. Meeting recordings are retained automatically.
Repository-local meeting files created by earlier versions are left in place.

### Extracted text

When a file enters a knowledge root, Verity derives a Markdown representation under
`.text/`. The artifact mirrors the source directory and uses a bounded deterministic name.
It records the source path, media type, processing state, and available locators such as
pages or timestamps.

The explorer hides `.text`. Previewing a binary knowledge file returns its derived Markdown
when available. Extraction metadata contains source size, modification time, and digest so
unchanged content is not processed again. Original and derived-file mutations are
serialized per path.

This first stage does not add a retrieval index. Agents use normal filesystem tools over
the read-only mount. Full-text or embedding-based retrieval can be added later as a derived
index without changing the storage layout.

### Project overview

`overview.md` is the bounded project context injected into new sessions. The
`verity-memory append` broker writes to this file while preserving its append-only and size
limits. Sandboxed agents cannot edit it through the mount.

On first access, an existing approved overview or legacy project memory is materialized into
`overview.md`. A durable migration marker distinguishes an unmigrated project from a project
whose overview was intentionally emptied, deleted, or moved, so deleted guidance is not
restored later.

The database-backed overview remains the fallback only until this one-time materialization
has completed.

### Compatibility and migration

Existing database-backed knowledge is not deleted by this change. Migration to files can be
performed incrementally:

| Existing artifact | Filesystem destination |
| --- | --- |
| Project Sources and originals | `<projectId>/imports/` |
| Project Wiki pages | `<projectId>/notes/wiki/` |
| Approved overview or legacy memory | `<projectId>/overview.md` |
| General/shared documents | `shared/` |

Database tables and compatibility routes may be removed only after a separate migration has
written and verified all required files. This ADR does not authorize dropping stored data.

## Security and operational boundaries

- Project identifiers are validated before they become path components.
- Private project folders are mounted only into sandboxes for that project.
- Moving a file to or from `shared` is an explicit scope change.
- Mounts are read-only; controlled server routes perform mutations.
- Explorer operations reject traversal, managed paths, symlink escapes, and overwrites.
- `overview.md` uses the existing project-memory character limit and is validated on read,
  upload, move, and broker append.
- Derived text is reference material. Its contents do not grant authority or override
  session instructions.

## Consequences

Agents and the application see the same durable files and paths. Binary material remains
readable through derived Markdown, and knowledge no longer requires a dedicated browsing or
grants interface for new content.

The shared folder is a coarser access boundary than per-folder grants. Files belong in a
private project folder unless they are intentionally shared. Existing database content
must remain accessible until migration is complete.

A large knowledge folder will eventually need indexed retrieval. Such an index is derived
state and must not become the source of truth.

## Implementation sequence

1. Create project and shared folder layouts and read-only sandbox mounts.
2. Add root-aware explorer operations and derived-text extraction.
3. Redirect chat saves, Drive imports, and meeting recordings to the folders.
4. Materialize and inject `overview.md`; keep legacy fallback until migration is marked.
5. Remove obsolete application surfaces while retaining backend compatibility needed for
   migration.
6. Add indexed retrieval later if filesystem search becomes insufficient.
