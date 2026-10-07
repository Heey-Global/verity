# File connections

Google Drive and future file providers use the bounded file-operation contract in
`packages/events/src/file-operations.ts`. Identifiers are opaque provider IDs,
not host paths. No complete folder synchronization is performed.

## Google Drive

Connect a folder in Project settings → Connections → Google Drive. New folder
connections start read-only. Enable **Allow changes to Google Drive files** to
allow writes. Existing linked folders retain their previous write permission
when upgraded. The server enforces the selected mode on agent tools and HTTP
file actions. Read-only also blocks native Docs, Sheets, and Slides edits while
allowing their read tools.

The agent's `verity_google_drive` tool supports:

- `capabilities`: discover write permission and provider-specific limits.
- `list`, `search`, `read`: browse and read only the linked folder and descendants.
- `upload`, `create_folder`: create regular files or folders without replacing an
  existing file. Drive permits multiple files with the same name.
- `overwrite`: replace regular file bytes. Native Workspace files cannot be
  overwritten; edit their contents using the dedicated tools.
- `rename`, `move`: change a file or folder inside the linked tree. Both source
  and destination must be authorized; a folder cannot move into its descendants.
- `trash`: move a file or folder, including its contents, to Google Drive trash.
  Restore it through Google Drive while it remains available there and your account has permission to restore it. Verity never
  empties the trash or permanently deletes through this operation.

The linked root cannot be renamed, moved, overwritten, or trashed. Shortcuts
are not followed to grant access outside the linked tree.

## Approval and conflicts

Read/write permission permits creating new files; it does not give blanket
approval to change existing files. Every overwrite, rename, move, and trash
operation requires an explicit approval card bound to that request. The payload
includes the target's name and ID. A folder trash card authorizes the folder and
its contents, not a frozen inventory of children.

Read the target first and provide its `expectedVersion` and current `name` in
mutation requests. A file or folder `read` returns this version. Drive v2 exposes
[resource ETags](https://developers.google.com/workspace/drive/api/v2/reference/files),
which Verity uses with conditional `If-Match` writes. A changed version is a
conflict, never a reason to retry with an unconditional write. Metadata and blob
writes use the same v2 representation; other Drive APIs retain their v3 paths.

Files downloaded for agent editing use the same conditional version, so a
concurrent edit during download also fails. Native exports remain read-only
representations, not binary replacements for native document contents.

Mutations are fenced by invocation ID. Completed retries reuse their result;
an uncertain in-flight operation asks the agent to inspect before trying again.
Project permission and the connected account are checked again before dispatch.
Drive does not offer a transaction across the target and all ancestors or
children: concurrent external folder moves or changes to a folder's contents
cannot be locked by Verity. The target write itself remains conditional.

HTTP callers must supply a current `expectedVersion` and `confirmed: true` for
rename/move, overwrite, and trash. The snapshot endpoint returns file metadata
and version. These authenticated user actions are separate from agent approval
cards; agents cannot self-approve by adding a request field.

The tool accepts up to 10 MB of encoded write content. Downloads retain their
50 MB cap. OAuth already uses the Drive scope; no additional consent is needed
for these operations. Credentials remain on the server.

## Provider capabilities

A provider must advertise its own recovery and concurrency semantics. Google
Drive supports recoverable recursive trash and conditional writes but does not
support native-document byte replacement. A future SMB provider must implement
its own version and recovery behavior, rather than claiming Drive's capabilities.
