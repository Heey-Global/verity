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
- **Google Drive:** a selected folder. Docs, Sheets, and Slides editing still
  requires explicitly assigning a native file in a session's file browser.
- **Google Gmail, Calendar, and Contacts:** enable each service separately for
  the project. These grants apply to every session in that project. Upgrading
  preserves older session-only grants without extending them to other sessions.
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

NAS/SMB and additional Drive file actions are separate planned features. They are
not presented as usable connections before their implementations exist.
