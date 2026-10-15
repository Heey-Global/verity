# Google connections

Google services use the existing OAuth client configured with `GOOGLE_AUTH_ID`.
Enable the [Google Calendar API](https://developers.google.com/workspace/calendar/api/quickstart/nodejs#enable_the_api)
for calendars/Meet and the [People API](https://developers.google.com/people/quickstart/python#enable_the_api)
for Contacts in that client's Google Cloud project. Configure the consent screen
for the scopes of the services you intend to use.

## Incremental consent

Before Google sign-in, Verity explains what access is needed and why. Each
connection requests only its own scopes; previously granted Google permissions
are retained through incremental consent, without requesting unrelated services.
Google may show existing permissions again during its consent screen.

| Action | Requested scopes | Purpose |
| --- | --- | --- |
| Connect email | `gmail.readonly`, `gmail.compose`, `gmail.settings.basic` | Read mail, prepare drafts, send after approval, and read the configured signature. |
| Connect Google Calendar | `calendar.calendarlist.readonly`, `calendar.events`, `userinfo.email` | Discover calendars, read events, make approved changes, and identify the connected account. |
| Connect Google Contacts | `contacts.readonly`, `userinfo.email` | Find names and email addresses for email recipients and calendar attendees; identify the connected account. |
| Connect Google Drive | `drive` | Browse/import files and use connected project folders as read/write workspaces. |
| First native file edit | `documents`, `spreadsheets`, and `presentations` together | Read/edit Docs, Sheets, and Slides. Google grants access to these file types across the account; Verity limits tools to the file assigned to the session. |

Scope names in this table have the prefix `https://www.googleapis.com/auth/`.
Connecting Gmail, Calendar, or Contacts does not request Drive or native editor
scopes. Drive availability is derived from the actual returned scopes, rather
than from the presence of a shared refresh token. Existing stored connections
retain their known permissions when upgrading; projects gain no Contacts
access until explicitly enabled.

Docs, Sheets, and Slides share one consent step when first opening a native file
for editing. Existing partial editor permissions are expanded to this bundle;
the bundle is not requested when merely connecting Drive.

## Project access and removal

Connect Google accounts under **Settings → Connections → Google**. Each account
has its own permissions, optional name and project usage. Grant only the services
you need through incremental consent. In **Project settings → Connections →
Google**, choose one account for each of Gmail, Calendar and Contacts.

Existing and future sessions inherit the current project default. In a chat,
choose another account, disable the service only for that chat, or select **Use
project default** to restore inheritance. Project changes affect inheriting
sessions; chat exceptions and other sessions remain unchanged.

Drive uses account-bound folders selected for the project, each with independent
read/write access. Native Docs, Sheets and Slides remain limited to the file
assigned to an individual session: open the session's folder icon, choose
**Google Drive**, tap a native file, and choose **Use in this chat**.
A single folder opens directly, multiple folders from one account form a folder
list, and folders across accounts are grouped by email address.

Existing session-only grants stay session-only when upgrading; stale account
bindings become disabled rather than inheriting access. Project grants remain
project defaults. Disabling a project default preserves explicit session grants.

Later tool calls, including a change awaiting approval, recheck effective access.
An HTTP request already sent to Google cannot be recalled. Contacts lookup checks
access again between Google's cache warmup and the actual search. Google Contacts
is read-only; ambiguous names or email addresses must be resolved with you before
sending mail or inviting attendees.

Disconnecting an account removes its project access and disables its session
exceptions without selecting a replacement account. Other accounts retain access.
Scope upgrades must return the selected identity. Account, credential and grant
changes invalidate pending approvals. Disconnecting waits for outstanding
temporary Slides image cleanup so its credentials remain available for cleanup.

## Calendar changes and Google Meet

The agent can list calendars, list events in a bounded time window, and read an
event. Creating, updating, and deleting events always requires a separate
approval. The card shows the calendar, event identifier where applicable,
submitted event fields, the Meet choice, and attendee notification behavior.

Supported event fields are title, description, location, start/end, and attendees.
Timed and all-day events are supported. Updating or deleting requires the `etag`
from a prior read; Google rejects stale changes made against a concurrently
modified event. Attendee notifications default to disabled and can be explicitly
requested with approved `sendUpdates: "all"`.

Before every new event, the agent asks whether to add Google Meet. `create_event`
requires an explicit `addGoogleMeet` boolean without a default, and the card
repeats the choice. When selected, Verity requests a new Meet conference for that
event. Creation may be pending; the agent must read the event again to obtain
the actual link and report failures accurately. Availability depends on the
connected calendar and Google account. Contacts lookup is optional: email
addresses supplied or confirmed by you also work without an address book.


## Gmail sender addresses

Gmail drafts can use an existing verified “Send mail as” address. The Gmail tool's
`list_senders` action lists available addresses; `create_draft` accepts an optional
`from` address and otherwise uses Gmail's configured default sender. Each draft
uses the selected address's signature.

Use `create_reply_draft` for replies. It preserves the own address used in the
selected message: the sender for sent messages, or a recognized recipient address
for incoming messages. If the address is missing, unrecognized, or ambiguous,
draft creation stops instead of silently switching identities. The sender remains
part of the snapshot presented for approval before sending. Configure and verify
new aliases in Gmail itself.
