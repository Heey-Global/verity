# Knowledge folders

Each project has a durable Knowledge folder on the Verity server. Open a
session's file explorer and choose **📚 Knowledge** to browse it, or **📚 Shared**
for files every project may read. Replacing a Sandbox does not remove these
files.

Verity creates this layout automatically:

```text
overview.md
meetings/
imports/
notes/
```

- `overview.md` is the short project context supplied to fresh agent sessions.
  The `verity-memory append` command adds operator-requested facts to this file.
- `meetings/` keeps meeting audio and its transcript automatically.
- `imports/` receives chat attachments selected with **Save to knowledge**,
  Google Drive imports, and files uploaded in the explorer.
- `notes/` receives chat messages saved through their Knowledge action.

The assignment is determined by the entry point; no folder choice is required.
The attachment checkbox remains off by default. Meeting recordings are retained
automatically.

## Agent access and extracted text

The project folder is mounted read-only at `/knowledge` in every project
Sandbox. Shared files are available at `/knowledge/shared`. Agents use ordinary
file tools such as `ls`, `grep`, and `cat`; there is no separate Knowledge tool
or Wiki maintenance flow.

Binary imports are processed into Markdown under a hidden `.text/` directory,
mirroring the source path. For example, `imports/offer.pdf` produces
`.text/imports/offer.pdf.md`. The app hides this implementation directory and
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

Knowledge folders are separate from repositories. Code, tests, build
instructions, and versioned architecture decisions still belong in the project
repository. New meeting recordings are not written to `docs/meetings/`.

There is no Wiki, folder grant screen, overview approval, or Knowledge model
setting. Retrieval indexing and semantic search may be added later on top of the
same files; the folder remains the source of truth.
