# Calendar meetings

Verity can watch Google calendars for online meetings and join them with the
Attendee bot described in [Attendee live meetings](attendee-live-meetings.md).
A calendar carries no project: one Google account usually serves many projects,
so a meeting joined from a notification or automatically always starts as an
[unassigned meeting](attendee-live-meetings.md#unassigned-meetings), and you
pick the project afterwards. Only a meeting joined from a session's meeting
screen is attached to that session right away.

Online meetings need a configured Attendee connection and Uplink / Online
Sharing; calendar meetings add nothing to these requirements.

## Choosing calendars

Settings › Google › Meeting calendars lists the calendars of every connected
Google account that granted Calendar access. Per calendar:

- **Watch for meetings** asks five minutes before each joinable meeting.
- **Join automatically** joins at the start time without asking. It is offered
  only for a watched calendar and is turned off when watching stops.

Calendars that only show free/busy times are not listed, because their events
carry no links. When Google cannot be reached for an account, the calendars it
already watches stay listed so they can still be turned off. Disconnecting a
Google account forgets its calendars. The same page sets how long unassigned
meetings are kept.

The routes are `GET /settings/calendar-watch` and `PUT /settings/calendar-watch`
with `{ accountId, calendarId, watched, autoJoin }`; both are administrator
routes. Watching a calendar checks with Google that the account can read it.
Stopping needs no Google request.

## Which events count

An event is joinable when it is confirmed, has a start and end time (not an
all-day event), was not declined by the calendar's owner, and has a Google Meet,
Microsoft Teams or Zoom link on HTTPS. Verity looks for the link in this order:
the event's Meet link, the conference's video entry point, other entry points,
then links in the location and in the description. Links on any other host are
ignored, so an unrelated link in an invitation never sends a bot. Manually
entered links pass the same check.

## The watcher

Once a minute the server reads each watched calendar from 15 minutes ago to 24
hours ahead and records the joinable events. Title and link are stored
encrypted, since meeting links often carry the passcode. An event that moved is
announced again unless Verity already joined it; an event that was cancelled,
declined or lost its link is forgotten.

- Five minutes before a meeting of a watched calendar, every active
  administrator receives `MEETING_UPCOMING`: "Weekly sync starts in 5 min",
  with **Join** and **Skip**.
- For a calendar set to join automatically, Verity joins at the start time
  and sends `MEETING_STARTED`: "Verity joined Weekly sync", with **Open** and
  **Discard**. The same notification follows every join that starts without a session.
- Nothing is announced or joined more than ten minutes after the start.
- A failed automatic join is not retried. The meeting can still be joined by
  hand while it runs.

Markers in the database keep a restart from repeating a notification or
joining twice. Only one join per event succeeds, whether it comes from a
notification, the app or the automatic join.

## Joining from the app

- `GET /live-meetings/upcoming` lists the meetings of the next twelve hours
  with title, time, calendar, provider and what Verity already did. It leaves
  the link out; joining reads it on the server.
- `POST /live-meetings/calendar/:eventKey/join` joins. With `{ "sessionId" }`
  the meeting starts in that session, otherwise unassigned. A second join is
  refused with 409 and the running meeting's id; an ended meeting is refused
  with 409.
- `POST /live-meetings/calendar/:eventKey/skip` skips a meeting. A skipped
  meeting can still be joined.

These are administrator routes, like the calendar settings. In the app, the
online source of a session's meeting screen lists these meetings under "From
your calendar"; picking one replaces typing the link, which stays available
behind "Enter link manually". Meetings that run without a project appear there
with "Continue here", which moves them into the session with everything said
so far.

## Notifications

The notification categories and their payloads are described in
[ADR 0008](adr/0008-push-notifications-quick-reply.md). Join and Discard need
the device unlocked. Tapping an upcoming meeting opens the app with Join and
Skip; tapping a started one opens the assign sheet, or the meeting itself once
it has a session.

## Limitations

- Only Google calendars are watched.
- All active administrators receive the notifications; there is no per-user
  choice yet.
- Calendar meetings are one source of unassigned meetings. Other sources, such
  as phone calls, are not available yet; they would enter through the same
  unassigned state.
