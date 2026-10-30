# Scheduling requests

A scheduling request offers meeting times to one guest through a booking link. You
name time windows in chat; Verity holds them in your calendar, invites colleagues to
the holds and emails the guest a link. The guest picks a start time on a public page,
and Verity books it for everyone and removes the remaining holds.

The design mockup is in [`assets/scheduling/mockup.html`](assets/scheduling/mockup.html).

## Flow

1. **Prepare.** The agent calls `verity_scheduling` with `prepare`: title, duration,
   windows, guest, colleagues, Google Meet, time zone, page language (English or
   German) and how many days the request stays open (at most 7). Verity checks your
   calendar, derives the start times and stores a draft. Nothing leaves Verity yet.
2. **Approve once.** `send` raises one approval card that shows the stored draft —
   not the agent's description of it — and covers the whole request: creating the
   holds and inviting colleagues, sending the email, booking the time the guest
   picks, and removing the other holds once the request is booked, expires or is
   withdrawn. The approval is bound to a digest of the draft.
3. **Provision.** Verity creates one hold per window (busy, colleagues invited),
   creates the public link and sends the email from your Gmail account. The email
   contains the link, not the times.
4. **Book.** The guest opens the link and picks a start time. Opening the page never
   books anything; only the explicit confirmation does.
5. **Close.** After booking, the hold of the chosen window becomes the appointment
   (title, guest, Meet, updates sent to everyone) and the other holds are removed.
   At the deadline, or when you withdraw the request, all holds are removed.

## Start times

Each window is cut into consecutive slots of the meeting's duration, starting at the
window's start; a slot must fit completely. A 14:00–16:00 window offers 14:00, 14:30,
15:00 and 15:30 for 30 minutes, and 14:00 and 14:45 for 45 minutes. A slot must also
start at least an hour from now. The deadline closes booking, not the calendar: a
meeting can take place after it, so a guest may pick a time three weeks out within
the first week. Booking closes at the latest when the last window ends.

## The calendar is the source of truth

Every page view and every booking reads the calendar live:

- Holds carry private extended properties (`verityScheduling`, `verityRole`,
  `verityPosition`). Deleting a hold stops offering its window; moving or resizing it
  changes the offered times.
- Holds of any scheduling request never block a time, so several requests may offer
  the same time in parallel. Everything else you attend blocks it, including partial
  overlaps, busy all-day events and appointments booked through other requests.
- If the calendar cannot be read, the page offers nothing and asks the guest to try
  again; nothing is booked from stale data.

Only the organizer's calendar is checked. Colleagues are invited to the holds, but
their availability is not checked; whether a hold shows as busy for them depends on
their calendar.

## Concurrency and recovery

- All bookings on one calendar run under a PostgreSQL advisory lock. Inside it the
  slot is checked live again and the hold is patched under its etag, so two guests
  can never take the same time, from the same request or from different ones. The
  second guest sees that the time was just booked, with the remaining times.
- Hold event ids are derived from the request, so a retried create cannot add a
  second hold.
- A booking interrupted between the calendar change and its bookkeeping is finished
  the next time the request is read: the appointment's marker in the calendar wins.
- Gmail has no idempotency key. If a send was started but never recorded, Verity does
  not send again; the request opens with a note and you are told to check your sent
  mail.
- A scheduler resumes provisioning, closes requests at their deadline, removes holds
  with exponential backoff (one alert after repeated failures), reconnects public
  links and retires them, all from durable state after a restart.

## Public link

Each request gets its own Uplink share with a 30-day lifetime and a six-digit PIN
carried in the link. Core serves the page from a loopback listener per request
through an in-process connector, like online meetings. After the booking deadline
the page explains that the request has expired until the link itself ends at day 30.
Turning online sharing off withdraws every open request. Uplink may limit the number
of concurrent shares; sending then fails with a clear error and removes the holds.

## In the app

The session shows a card per running request with its windows, the guest's link and
a Withdraw action. **Settings → Google → Scheduling requests** lists every request the
user may steer: those of projects where they have execute access (the view carries
the guest's link with its PIN), grouped into needs attention, open and recent.
Requests outlive their chat: deleting a session leaves its requests running until
they are booked, expire or are withdrawn there.

Bookings, requests without remaining times, unconfirmed emails and holds that could
not be removed are posted into the session and sent as push notifications.

## Limits

- One guest per request; at most 10 windows and 10 colleagues.
- Booking stays open for at most 7 days; windows may start up to 60 days ahead.
- Colleagues' availability is not checked.
- The page is available in English and German.
