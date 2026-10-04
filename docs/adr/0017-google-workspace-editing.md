# ADR 0017 — Session-Assigned Google Workspace Editing

**Status:** Proposed · **Date:** 2026-09-19

## Context

ADR 0016 lets a session edit one assigned native Google Slides presentation in place. The same
workflow is useful for documents and spreadsheets: the file remains in Google Workspace, other
people can continue editing it, and Verity makes bounded changes through Google's native APIs.

The APIs do not share an editing model. Slides and Docs expose revision-controlled batch updates;
Sheets addresses cells and ranges but provides no equivalent whole-spreadsheet compare-and-swap.
The Docs and Sheets APIs also cannot edit `.docx` or `.xlsx` files stored in Drive.

## Decision

A session has exactly one assigned native Google Workspace file: a Slides presentation, Docs
document, or Sheets spreadsheet. Assigning another file replaces the current assignment. The
existing Drive browser lists all three native types and their Office counterparts; Office files
remain visible but require explicit conversion to the matching Google format before assignment.

Assignment is the authority boundary. Every tool invocation verifies the calling project and
session, the assigned file kind, and the assignment generation. Mutations recheck the assignment
immediately before calling Google. Invocation results are persisted so a retried mutation is not
silently executed twice.

The OAuth connection adds the account-wide `documents` and `spreadsheets` scopes alongside the
existing `presentations` scope. This grants the refresh token broad access, while Verity restricts
its own behavior to the single file explicitly assigned to the session. A future Google Picker
flow can narrow authorization to files selected under `drive.file`.

### Docs

The Docs tool exposes document inspection, bounded reads, and Google's full batch-edit vocabulary.
Docs content uses UTF-16 indices, so edits require the revision returned by the preceding read.
Google rejects the batch if the document changed before the write.

### Sheets

The Sheets tool reads metadata first and only reads or writes explicit bounded A1 ranges. It
supports value replacement, range clearing, and Google's full structural batch-update vocabulary.
Google's append API can place values outside the supplied lookup range when it detects an offset
table, so table appends are deliberately excluded. Direct value payloads and ranges, batch payload
size, and request count are capped. Structural operations may address larger areas because their
effect is represented by a small Google request rather than transferring every affected cell.

Sheets has no revision guard equivalent to Slides or Docs. The tool therefore rechecks the active
assignment immediately before each mutation and uses an invocation fence for retries. Concurrent
changes inside the same target range can still race; Verity does not claim serializable spreadsheet
edits.

### User interface

The session file browser exposes **Google Drive**. Selecting a native file and choosing
**Use in this chat** assigns a Slides, Docs, or Sheets file; a type-specific chip opens
or clears the active file. Account consent is also available under **Settings →
Connections → Google**. The authoritative visual view remains Google's editor;
Docs and Sheets do not add generated previews.

## Consequences

- Prompts stay unambiguous because only one editable Workspace file is active per session.
- Existing Slides assignments migrate as `slides` and continue to work.
- Reconnecting Google Drive is required before an existing refresh token gains the new scopes.
- Native collaborative history remains in Google rather than Git.
- Direct in-place editing of PowerPoint, Word, and Excel files remains unsupported.
