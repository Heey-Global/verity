# Connections

Start with pairing, device security, a master password, and one AI provider.
GitHub, Google, Matrix, Doppler, and MCP can be configured later. GitHub author
and signing setup remain available in the setup checklist; they are needed for
GitHub work, rather than for starting a local project.

## Settings

- **Connections:** connected services first, followed by available services in
  AI, Code, Files & documents, Messaging, Secrets, and Advanced. GitHub appears
  first when connected. Project usage counts help locate existing bindings.
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

## Forge connection API

Administrators can list forge metadata with `GET /connections`, add a Forgejo
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

Existing GitHub configuration endpoints remain authoritative for the GitHub
App connection; credential updates and disconnects synchronize its encrypted
connection record in the same transaction. Projects and pending repository
reservations are keyed by connection as well as owner and repository name.
Removing a connection referenced by a project or reservation returns a conflict.
These APIs prepare Forgejo connections; project creation requires the provider
and sandbox integration to be enabled separately.
