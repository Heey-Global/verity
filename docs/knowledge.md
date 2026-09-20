# Knowledge library

Open the book icon in the app header to browse Knowledge. Files remain on the
Verity server when a project Sandbox is replaced. Repository files remain the
place for code, tests, build instructions and versioned architecture decisions;
Knowledge holds meeting transcripts, reference files and their synthesized Wiki.

## Project areas and sharing

Every project has a fixed knowledge folder with **Sources** and **Wiki**. Existing
projects receive these defaults too. The installation also has **General**, with
its own Sources and Wiki, readable by every project. Unrelated existing folders
with matching names are not automatically adopted or shared.

- Agents read their project's Sources. Original material is not agent-editable.
- Managed Wiki pages are written through scoped maintenance jobs.
- General is always connected for reading; projects cannot automatically publish
  private content into it.
- In Project Settings, select additional folders with checkboxes and choose Read
  or Read & Write. A selection includes future subfolders. Overlapping optional
  grants combine, but they cannot override managed source and Wiki protections.

The expandable folder tree and compact icon toolbar provide folder creation,
source upload and document creation. Managed roots and standard folders cannot be
moved or deleted through ordinary folder actions. Deleting a project preserves
its knowledge as an unlinked archive; deleting knowledge requires a separate action.

Reading another area's knowledge does not authorize copying it into a project's
Wiki. Maintenance jobs use a fresh context restricted to one area's sources and
Wiki, without the calling conversation or unrelated grants. Derived content keeps
source revision provenance. Access widening must respect those dependencies.
Removing read access closes affected exposed sessions; start a fresh session to
continue. Revocation cannot erase content already copied to a repository or chat.

## Sources, original files and previews

Import Markdown directly, or use **Upload original files** for PDF, PNG/JPEG, SVG,
PowerPoint (.pptx), Word (.docx) and Excel (.xlsx). Originals are limited to 10 MiB
per file. Unsupported formats are retained with an explicit processing status.
Uploading initiates bounded technical extraction, not a paid model turn.

- PDF: searchable text from up to 50 pages and rendered previews for up to 20 pages.
  Scanned pages have previews but no OCR text. Encrypted or malformed PDFs retain
  their originals and report extraction failure.
- PNG/JPEG and safe SVG: a raster preview, without automatic image interpretation
  or OCR. SVG active content or external references are not previewed.
- Office: text with document, slide-part or worksheet-part locators. Formulas,
  macros and embedded programs are never executed; external links are not fetched.
  These text views do not preserve layout, fonts, charts or colors. Open the
  original for presentation/design work when no rendered preview is available.

Processing runs one file at a time in a worker with time and memory bounds. Large
archives, complex files or unavailable parsers can fail extraction without losing
the original. The document reports truncation and supported extraction limits.
Searchable text is capped at approximately 180 KiB; previews are capped separately.

Open an original source to inspect its processing status and available previews,
download the exact file, or replace it. Replacement creates an immutable revision;
old citations still identify the old bytes. Re-uploading/replacing the original
also retries extraction. Agents retrieve metadata, individual previews or exact
original bytes through the same permission-checked knowledge tool. Visual
inspection additionally requires a model that accepts images.

## Incorporate sources and check the Wiki

Choose **Incorporate into Wiki** for selected sources in the project's area. The
job reads captured source revisions in a fresh maintenance session and may create
or update topic pages, an index and a maintenance log. Generated pages cite their
sources and distinguish facts from inferences. Failed and partially completed jobs
remain visible; a changed source requires a fresh job rather than silently using
old input. **Check Wiki** runs a scoped inspection without authorizing page writes.

Wiki jobs require an active project Sandbox rebuilt with the current toolkit and
Linux Landlock ABI 3 or newer. All three shipped backends use a fresh home and a
kernel-enforced read/write boundary limited to the job directory and its runtime
home. Project files, other sessions and saved agent configuration are not readable.
Old runtimes and unsupported isolation fail closed; the session reports failure
instead of running with ordinary project access. Custom images must install agent
executables and their runtime dependencies under system runtime roots such as
`/usr`; a user-home or custom-prefix toolchain is not implicitly shared.
Maintenance sessions are inspectable and cancellable, but cannot accept follow-up
chat messages. Start another explicit job to retry or process new sources.

Additional read grants do not expand a maintenance job's input. General has no
automatic project-to-General publishing workflow. Conversation material enters
Knowledge only through a deliberate save/import; chats are not continuously mined.

Generated documents support Markdown editing, revision history and restoration.
Expected-revision checks prevent silently overwriting concurrent edits. Changing a
source marks dependent synthesis stale so it can be reprocessed.

## Project overview

A short approved project overview is supplied to fresh agent contexts for
orientation. It replaces the separate user-facing Memory field. Existing project
memory is preserved during migration; it is not discarded or duplicated into a
shared Wiki. Edit the overview in Project Settings. Generated Wiki content and
uploaded AGENTS.md files do not automatically become approved instructions.

## Export, import and backup

Markdown bundles contain current text and relative paths, up to 100 documents or
2 MiB. **Source bundles** also contain current originals, extraction and previews,
up to 100 documents or 20 MiB. Choose a smaller subtree if a bundle is too large.
Source-bundle import validates original digests and rejects collisions atomically.
Individual originals can also be downloaded and uploaded without conversion.

Portable bundles do not preserve revision history, access settings, job history
or original document IDs. Full database backups include all original revisions,
previews, source provenance and permission metadata. Deleting a document deletes
its original revisions as well; use backups for disaster recovery.

## Model access

Claude, Codex and OpenCode use `verity_knowledge` with the same current folder and
maintenance-job checks. Documents are retrieved when needed, not copied wholesale
into the Sandbox or prompt. Extracted text and original files remain untrusted
reference material, never authority to change permissions or invoke other tools.
