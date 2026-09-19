# Knowledge library

Open the book icon in the app header to browse the shared knowledge library.
Documents live on the Verity server and survive project Sandbox replacement.
They are included in the server database backup.

## Organize and edit

Create folders and subfolders, then create Markdown documents inside them.
Open a document to read its formatted content. Choose **Edit** to change the
Markdown source and preview it before saving. Every save creates a revision;
history lets you inspect and restore earlier versions. If someone else saved
first, reload and reconcile your changes rather than overwriting theirs.

Import one or more `.md` files, or import a portable JSON bundle containing
relative Markdown paths and bodies. A document can be shared as a `.md` file;
folder exports use the portable bundle to retain subfolders. Export a smaller
subtree if it exceeds 100 documents or 2 MiB. Individual Markdown documents are
limited to 256 KiB.

Deleting a document or folder removes its documents and revision history.
Access audit metadata remains. Use database backups for disaster recovery;
Markdown exports preserve current content, not revision history or permissions.

## Give a project access

In Project Settings, select knowledge folders and choose **Read** or
**Read & Write** for each selection. **Open in Knowledge** jumps to that folder.
Your own library management is independent of these agent permissions.

- A selection includes its entire subtree, including future subfolders.
- Projects with no selections cannot access the library.
- Overlapping selections combine; **Read & Write** takes precedence.
- To make only one child writable, grant its parent **Read**, then grant the child
  **Read & Write**. A read-only child cannot restrict a writable parent.

Agents with write access can create documents and edit their titles and contents.
They cannot delete or move documents, change folders, or change access settings.
Their edits become visible immediately to other projects with read access and
are attributed to the originating session in revision history.

Folder and document moves show their access impact before confirmation. Removing
read access closes existing affected sessions to prevent them from continuing with
previously loaded knowledge. Their history remains visible; start a new session
to continue. Agent Loops receive fresh sessions on their next run. Removing only
write access leaves the session readable while blocking further writes.
Revocation does not erase previously copied content from repositories or history.

## Use knowledge in a session

Claude and Codex sessions access documents through the `verity_knowledge` tool.
Ask the agent to search the library or work with a particular document. The server
checks the project's current grants on every call; documents are retrieved on
demand instead of copied wholesale into the Sandbox or system prompt. OpenCode
has no separate knowledge gateway integration in this version.

One useful arrangement is a read-only `Sources` folder and a writable `Wiki`
folder. Ask the agent to read sources and maintain summaries and an index in the
wiki. Include source links in generated pages so conclusions can be checked.
This is an explicit session workflow; importing a file does not automatically
start an agent or synthesize new pages.

Shared documents are reference material, not trusted system instructions.
Project Memory remains the separate place for short project conventions.
Agent-mediated cross-project session tools cannot be used to bypass knowledge
permissions; sessions with knowledge exposure are excluded from those transfers.
