# Network shares

Network shares let agents work with folders on a file server or NAS over SMB,
the protocol Windows Explorer and macOS Finder use for shared folders. An
administrator connects a share once; each project then gets individual folders
on it, read only or read and write.

## Requirements

- The Verity server must reach the NAS on the network, for example because both
  are in the same local network or the server is connected through a VPN. Verity
  does not provide a tunnel into private networks.
- The share must offer SMB 3 with encryption. Verity refuses servers that cannot
  encrypt the connection, so file contents never cross the network in the clear.
- An account on the NAS for Verity. Agents can never do more than this account
  may; giving it access only to the shared folders Verity needs keeps the limit
  on the NAS as well.

### Example: Synology NAS

On a Synology NAS running DSM 7:

1. In **Control Panel › File Services › SMB**, enable the SMB service. Under
   **Advanced Settings**, set the minimum SMB protocol to SMB3 and the transport
   encryption mode to **Client defined** or **Force**; Verity always asks for
   encryption.
2. In **Control Panel › User & Group**, create a user for Verity and give it
   read/write or read-only permission on the shared folders it should reach.
3. The address is `smb://<nas-name-or-ip>/<shared-folder>`, for example
   `smb://diskstation.local/team`. The shared folders are listed under
   **Control Panel › Shared Folder**.

Other NAS systems and Samba servers work the same way: enable SMB 3, allow
encryption, create an account and use the shared folder's address.

## Connect a share

In **Settings › Connectors › Network shares**, choose **Add network share** and
enter a name, the address (`smb://server/shared-folder` or
`\\server\shared-folder`), the username and the password. Verity signs in with
encryption before it saves anything; a wrong password, an unknown shared folder
or a server without encryption is reported at the field it concerns.

The password is stored encrypted on the Verity server and is never shown again,
returned by the API or given to agents. Each share shows whether it is currently
reachable.

A new address needs the password entered again: the saved password is only
ever sent to the server it was entered for. Changing a share's address ends
every project's access to it: folders granted
for one server or shared folder never silently follow it to another. Add the
folders to the projects again afterwards. Changing only the username or
password keeps the folders, but agents then act as the new NAS account: what
that account may read or change inside the granted folders is what agents can.
**Disconnect share** removes the share and every project's folders on it; the
files stay on the NAS.

## Give a project folders

In **Project settings › Connectors › Network shares**, choose **Add folder**,
pick the share, open the folder and choose **Use this folder**. Then choose:

- **Read only** (the default): agents can browse folders and read files.
- **Read and write**: agents can also create files and update existing ones.

The folder includes its subfolders. Tap a folder in the list to change its
access or remove it from the project. Removing a folder or lowering its access
applies to the next agent action, also in sessions that are already running.
When a project gets its first folder, sessions that are already running may only
see the network share tools after they are restarted. Project members can see which
folders their project uses; adding, changing and removing them is for
administrators.

## What agents can do

Agents in Claude and Codex sessions use these tools:

- `verity_share_folders`: the folders granted to the project and their access.
- `verity_share_list`: folders and files inside a granted folder.
- `verity_share_read`: a file's content, as text when it is valid UTF-8 and as
  base64 otherwise, with its version.
- `verity_share_create`: a new file. It fails if the name already exists and
  never replaces a file.
- `verity_share_update`: replaces a file. It needs the version from the agent's
  latest read and an approval card for every update.

If the NAS refuses the saved sign-in details, agents leave the share alone for
five minutes instead of retrying, so a changed NAS password does not lock out
the Verity server. Entering the new password in the share's settings ends the
pause at once.

Deleting, renaming and moving files and creating folders are not available.
Reads are limited to files of 10 MB; the size is checked before and after the
transfer, and a file that grows during it is bounded only by the timeout. A write is limited by the 2 MiB size of
an agent tool request, so about 2 MB of text or 1.5 MB of base64-encoded
content per create or update. Each step of an operation times out after 30
seconds.

## Folder boundaries and conflicts

Paths are relative to the granted folder. Verity rejects `..`, alternate data
streams and other special names before a request reaches the NAS, so a path can
never name something outside the folder.

The NAS itself resolves symbolic links inside a share, and SMB does not tell
the client that an entry is a link. A link inside a granted folder that points
elsewhere on the same share therefore opens its target. If the share contains
such links, disable following them on the NAS (for Samba, `follow symlinks = no`
or `wide links = no` on the share), or grant only folders without them.

An update only replaces the exact file the agent read. Verity uploads the new
content under a temporary name, moves the current file aside, compares it byte
for byte with the version the agent read and only then puts the new file in
place. If someone changed the file in the meantime, the original is put back and
the agent gets a conflict instead of overwriting the change. If the original
cannot be put back because a new file took its name in the meantime, both are
kept: the new file under the name, the original under a hidden
`.verity-….old` name next to it, and the agent is told so. If the connection drops while the original is moved aside and
Verity cannot reach the NAS to put it back, the agent is told to check the
folder: the original then remains under its hidden name. The same applies if the Verity server stops during
those moments: look for a hidden `.verity-….old` file next to the file and
rename it back. Creating a file
fails instead of replacing one that appeared in the meantime. A program that
keeps the file open and writes to it during those few moments is not detected.

## Logging

Every agent call is recorded in the tool audit trail without its arguments.
Writes are also logged by the server with project, folder, path and size; file
contents and credentials are never logged.

## Server installation

The Verity server image includes Samba's `smbclient`, which carries out every
SMB operation. When running the server outside the image, install `smbclient`
(Samba 4.15 or newer) so it is on the server's `PATH`.
