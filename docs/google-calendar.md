# Google Calendar session access

Google Calendar uses the existing Google OAuth client configured with
`GOOGLE_AUTH_ID`. Enable the Google Calendar API in that client's Google Cloud
project and allow the Calendar and email identity scopes in its consent configuration.
See [Google's setup instructions](https://developers.google.com/workspace/calendar/api/quickstart/nodejs#enable_the_api).

In the session's attachment menu, choose **Google Calendar** to sign in and enable
Calendar access for that session. **Connect email** enables Gmail separately; both
can be enabled together. Each active connection appears above the composer with
its account email and a disconnect button.

Disconnecting a connection removes that session's access immediately. Later tool
calls, including a change awaiting approval, must recheck the session grant. An
HTTP request already sent to Google cannot be recalled. Other sessions and the
shared Google sign-in remain connected. Disconnecting Google in service settings
clears both services' session grants. Changing Google accounts also clears old
session grants, requiring explicit enablement for the new account.

The agent can list calendars, list events in a bounded time window, and read an
event. It can create, update, or delete events only after a separate approval for
each change. The approval card shows the calendar, event identifier where applicable,
submitted event fields, and whether attendee notifications are requested.

Supported event fields are title, description, location, start/end, and attendees.
Both timed and all-day events are supported. Updating or deleting requires the
`etag` from a prior event read; if the event changes while approval is pending,
Google rejects the stale change. Attendee notifications default to disabled and
can be explicitly requested with `sendUpdates: "all"`.

The Calendar consent flow requests `calendar.calendarlist.readonly`,
`calendar.events`, and `userinfo.email`, together with the existing Workspace
scopes. Incremental Google consent preserves already granted Gmail/Calendar
permissions. The server checks the permissions actually returned by Google and
removes session grants for services whose permissions are missing.
