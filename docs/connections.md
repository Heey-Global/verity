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

## MCP Apps in web chat

Enabled HTTP MCP connections can provide interactive tool results through the
[MCP Apps extension](https://apps.extensions.modelcontextprotocol.io/). Verity web
shows these as separate app cards alongside the tool's ordinary text result.
Native clients display the text fallback.

The first implementation supports inline HTML views and app-to-server tool calls.
Each action uses the app's original MCP connection, checks current project access
and tool visibility, and requires a fresh permission decision. App-only tools are
hidden from the agent. Views cannot call tools on another connection or access
Verity credentials, page storage, or the parent document.

Views run in sandboxed iframes. CSP blocks resource loads and fetch connections
unless explicitly declared with exact HTTPS origins. This is not full network
isolation: browsers still permit a view to navigate itself, potentially sending
its app data to another origin. Only enable Apps from trusted MCP providers. A
second frame load revokes the bridge and shows the text fallback. Nested frames,
workers, forms, native device permissions, chat-context updates, downloads and
external-link requests are not enabled in this first implementation.

The last tool result is restored from session history without running the tool
again. Loading a view or performing an action opens a fresh upstream MCP session;
servers should carry application state in tool arguments/results rather than rely
on the original transport session. Removing the project binding, disabling the
connection, or changing its credentials makes existing cards unavailable for new
reads and actions. The stored text result remains in chat history.

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
This adds Code by fetching the repository. Documents and archived local history
stay on the Verity server and are never imported into the remote repository.
Existing document sessions keep their working copies.

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
validates credentials with `/api/v1/repos/search` and verifies that invalid tokens
are rejected before persisting them. No user-read scope is required. Responses
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
connect Code to a local project. Configured document storage is required so legacy
files can be retained before connecting. The existing `link-github` route remains available.
Selecting a Forgejo connection requires administrator access and a fully
configured project relay/provisioner. New Forgejo clone and container names
include a hash of the connection and repository identity. Existing clones retain
their paths, including when a local project is linked.

Agents in a Forgejo project use `verity-repo` instead of `gh`, which only
reaches GitHub. `verity-repo pr create`, `pr ready`, `pr view`, `issue list`,
`issue view` and `issue comment` call `POST /internal/project/repo` with the
container capability. The server resolves the project and its repository from
that capability and the project socket, ignores any repository named in the
request, and runs the action through the project's code host with server-held
credentials. Pull requests are always opened ready for review: a Forgejo `WIP:`
title prefix is removed, and `pr ready` clears it on an existing pull request.
Local projects answer with a "no code host" error. The session prompt names
`verity-repo` for Forgejo projects; GitHub projects keep `gh`.

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


### Private Forgejo instances

Forgejo connections require HTTPS, including on private networks. Configure
`customCaPem` with the connection's PEM CA bundle for an internal certificate
authority. API and broker upstream requests use this trust only for that
connection; server Git sets URL-specific `http.<url>.sslCAInfo`. Sandbox Git
trusts a separate broker CA. Certificate chain, validity and DNS/IP subject
alternative name verification remain enabled; there is no insecure TLS mode.
A token or CA change invalidates subsequent provider lookups and cached PR data.
Session-worktree fetches re-read the Forgejo connection credentials and CA for
each new session. They disable redirects and scope authentication and CA trust
to the configured repository URL. Forgejo projects never mint GitHub App tokens,
even when a GitHub project has the same owner and repository name.

A repository/issue-scoped token does not need `read:user`. Connection validation
and listing use `/repos/search`; the search response lists repositories visible
to the token, including public repositories. Validation also probes the same
endpoint with a randomly generated invalid token and fails closed unless that
probe is rejected with 401 or 403. A public search that ignores credentials
cannot validate a connection. `/user` and `/user/repos` are not required (older
Forgejo versions apply the user scope to the latter as well). Git uses a fixed
username with token authentication. Scope, TLS and connection failures are
reported without returning tokens.

PR lookups share a two-second repository snapshot and coalesce concurrent
requests, with a five-second cooldown after a failed scan. The base/head lookup
requires a known base branch, so branch discovery retains a paginated fallback
covering PRs against any base. Commit statuses supply check counts; Actions runs
only detect work still running. Warning statuses are terminal failures, and a
false mergeability result remains unknown because it can mean checking is still
in progress. Merges use an allowed repository merge method, preferring its
default, and retain the expected-head guard. A 405 response does not disable
merge support permanently.

Acceptance against a live instance remains necessary. Git LFS and signed
bootstrap commits are separate follow-ups.
