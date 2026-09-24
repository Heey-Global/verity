# Knowledge folders

Each project has a durable Knowledge folder on the Verity server. Open a
session's file explorer and choose **📚 Knowledge** to browse it, or **📚 Shared**
for files every project may read. Replacing a Sandbox does not remove these
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
- `sources/meetings/` keeps meeting audio and its transcript automatically.
- `insights/` contains knowledge distilled from those sources. Agents may create and
  revise Markdown here with ordinary filesystem tools.

The assignment is determined by the entry point; no folder choice is required.
The attachment checkbox remains off by default. Meeting recordings are retained
automatically.

## Agent access and extracted text

The project folder is mounted at `/knowledge` in every project Sandbox. The mount is
read-only except for `/knowledge/insights`. Shared files are available read-only at
`/knowledge/shared`, with the same `sources/` and `insights/` organization. Agents use ordinary
file tools such as `ls`, `grep`, and `cat`; there is no separate Knowledge tool
or Wiki maintenance flow.

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

Upload, delete, and move files from the explorer. Moving a file to Shared makes
it readable by every project; moving it back to Knowledge limits it to the
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
