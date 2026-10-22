# Connections

Start with pairing, device security, a master password, and one AI provider.
GitHub, Google, Matrix, Doppler, and MCP can be configured later. GitHub author
and signing setup remain available in the setup checklist; they are needed for
GitHub work, rather than for starting a local project.

## Settings

- **Connections:** connected services first, followed by available services in
  AI, Code, Files & documents, Messaging, Secrets, and Advanced. The Code group
  lists GitHub and Forgejo as equal rows; each shows **Connected** with its
  project count, or **Connect** while it is not set up. Project usage counts help
  locate existing bindings.
- **Server:** updates, Remote access through Uplink, and meeting transcription.
- **Security:** the secret store and paired devices.
- **This app:** the server address saved on this device.
- **Advanced:** Verity Control visibility.

Connect account credentials once on the server, then select the connection's
scope in **Project settings → Connections**. Connected services appear there;
**Add connection** opens the catalog. Credentials never need to be copied into
individual projects.

## Project scopes

- **GitHub:** the project's repository. Author and signing configuration stay
  server-wide.
- **Google Drive:** one or more account-bound folders, each with read-only or read/write access. Docs, Sheets, and Slides editing still
  requires explicitly assigning a native file in a session's file browser.
- **Google Gmail, Calendar, and Contacts:** enable each service separately for
  the project and choose one account per service. Existing and new sessions inherit
  the current project default. A session can select another account or disable
  a service for that chat; resetting the exception restores inheritance. Changes
  in a chat leave the project default and other sessions unchanged.
- **Matrix:** select invited rooms in project settings. The global account screen
  gives an overview; existing room assignments survive the navigation change.
- **Doppler:** choose a project and configuration.
- **MCP:** enable the configured servers needed by the project.

The new-project flow offers an optional connection setup stage after creating the
workspace. Choosing a service opens its scope settings; it does not automatically
permit access to account data. Skip it to start working immediately. The session
attachment menu also provides shortcuts to the Google project settings.

A Google Drive suggestion in the files browser can be hidden on this device.
Hiding it does not change access, and project settings remain available.

Drive file actions and approval/recovery behavior are described in [File connections](file-connections.md). NAS/SMB remains a separate planned feature and is not presented as usable before
its implementation exists.

## Google accounts

Settings → Google lists connected accounts by email, with optional display names,
authorized services and project usage. Add, reconnect or remove accounts individually.
Service permission upgrades verify the selected account identity. Removing an
account removes its access without substituting another connected account.
Google sender aliases remain sender identities within their Gmail account.

## Code hosts in the app

The app works with GitHub and one Forgejo server, in any combination: GitHub
only, Forgejo only, both, or neither. **Connect Forgejo** asks for the server's
HTTPS address and an access token with read and write access to repositories,
issues and user; a custom CA certificate is optional. The server validates the
token before storing it, and the token never returns to the app. While projects
use the Forgejo connection it cannot be disconnected.

**New project** offers each connected code host plus **Local project**, which
lives only on this Verity server. The last code host used is preselected, and
the repository list belongs to the selected host. Forgejo is offered only when
the server can run Forgejo projects. A local project can later be connected to
an existing repository on either host in **Project settings → Repository**.

Project headers, issue references and the pull request bar show the code host's
own mark and open the repository, issue or pull request on that host.

## Forge connection API

Administrators can list forge metadata with `GET /connections`, which also
reports `forgejoProjectsAvailable` — whether this server can run Forgejo
projects, so clients offer Forgejo only where creation can succeed. Add a Forgejo
connection with `POST /connections`, rotate its token or update its label and
CA bundle with `PATCH /connections/:id`, and remove an unused connection with
`DELETE /connections/:id`. Creation accepts `label`, an HTTPS `baseUrl`, a
personal access `token`, and an optional PEM `customCaPem` bundle. The server
validates credentials against `/api/v1/user` before persisting them. Responses
contain metadata only; tokens remain encrypted in the server store.

Connection origins cannot be changed. A reverse-proxy path prefix and a custom
HTTPS port are supported. Requests use the connection's CA bundle, enforce a
15-second deadline, and reject redirects. Repository enumeration is available
at `GET /connections/:id/repositories` and follows numbered API pages.
`GET /connections/usage` counts Forgejo projects per connection id under
`forgejo`.

Existing GitHub configuration endpoints remain authoritative for the GitHub
App connection; credential updates and disconnects synchronize its encrypted
connection record in the same transaction. Projects and pending repository
reservations are keyed by connection as well as owner and repository name.
Removing a connection referenced by a project or reservation returns a conflict.
These APIs prepare Forgejo connections; project creation requires the provider
and sandbox integration to be enabled separately.

The Forgejo provider supports repository lists, open issues, pull request
creation, lookup and merging, commit statuses and Actions runs. Pull request
lookups match both the branch name and its repository, and merge requests pass
the expected head commit to Forgejo. Unsupported operations are reflected in
provider capabilities. Release badges remain disabled for Forgejo. Credentials
are resolved per operation so token rotation does not retain stale tokens.

Forgejo project creation accepts `{ "repo": "owner/repository", "connectionId":
"..." }` at `POST /projects`; the selected connection determines the provider.
`POST /projects/:id/link` requires the same repository and connection fields to
publish a local project. The existing `link-github` route remains available.
Selecting a Forgejo connection requires administrator access and a fully
configured project relay/provisioner. New Forgejo clone and container names
include a hash of the connection and repository identity. Existing clones retain
their paths, including when a local project is linked.

For a session in a Forgejo project, `GET /sessions/:id/branches` reports the
project's `owner` and `repo` and a `codeHost` with the connection's base URL,
so issue and pull request links open on that instance rather than on GitHub.

Forgejo sandbox Git uses an opaque project/container capability through the
HTTPS broker. The broker checks the current project connection and repository,
uses the upstream connection's port and CA, and substitutes the real personal
token only on the server. The sandbox trusts a separate public broker CA and
receives a host-specific broker certificate. Tokens are never returned by the
retired `/internal/github/token` endpoint. Changing a connection's token or CA
affects subsequent requests without distributing credentials to sandboxes.
