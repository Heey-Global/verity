# Verity assistant

The assistant is the general function of Verity: a persistent session, Verity ·
Assistant, that lives in Verity Control. You reach it by voice note or chat and
it turns short requests into outcomes: an answer, a task in the right project,
or a briefing handed to a project session. QA ([CI supervision](ci-supervision.md))
is a separate role of each coding project, not part of Verity Control.

## Switching it on

Settings → Assistant holds the installation-wide switch. It is off by default and
only administrators can change it. Turning it on creates the session in Verity
Control (turning it on again recreates a deleted session); turning it off stops
a running turn, keeps the session and its history, and refuses every assistant
tool call until it is on again. Notes already queued still reach the session.

While it is on, the session is not listed in Verity Control, on Home or in any
other session list, and adds nothing to their "waiting for you" counts: the
conversation, its questions and its approvals live behind the floating V, whose
badge counts what waits. The panel's expand button opens the full session.
Switched off, the session is listed again so its history stays reachable.

Mail, calendar and contacts use the Google accounts assigned to the Verity
Control project (Settings → Assistant → Mail and calendar). Sending mail and
changing events keep their approval cards.

## Project access

The assistant has no access to any project until someone grants it in
Project settings → Agents → Functions → Assistant:

| Mode | The assistant may |
| --- | --- |
| Off · no access (default) | nothing in this project |
| Tasks only | file tasks into the project's backlog |
| Tasks and sessions | also hand work to the project's sessions with `verity_session_handoff` |

Granting needs execute permission on the project and an enabled assistant.
Revoking needs execute permission too, but works while the assistant is off.
Verity Control itself can never be granted.

When a request names a project the assistant has no grant for, it does not try
the request. It tells the user this path and the mode the request needs, because
in-app links open the current project and cannot point at another project's
settings. The `projects` action returns the same steps in `grantHelp` without
naming any project that is not granted, and the `Let the assistant use a project`
app help topic explains them too.

## Enforcement

- The assistant session is identified by its stored session id, never by its
  name, the same way a project's QA session is.
- `verity_assistant` is advertised to Verity Control sessions but runs only for
  the enabled assistant session. `projects` lists granted projects the turn's
  user can still read (administrators count as readers, as in the project
  routes); `add_task` files a task owned by that user after checking the grant
  and that read access.
- A handoff from the assistant session needs a "Tasks and sessions" grant and
  the turn user's execute permission on the target project, the same membership
  every later tool call of that turn is checked against. It is checked before
  a new session is created and again right before delivery. Handoffs from other
  Verity Control sessions are unchanged.
- Every handoff asks the target session to publish a short outcome summary with
  `verity_publish_session_progress` when it is done or blocked. Verity records
  each handoff the assistant delivers (target session, project, title, the
  turn's user and the time). The `delegated_results` action of
  `verity_assistant` returns, for the newest of those handoffs from the last
  seven days, either the summary the target published since the handoff
  (outcome delivered or not, summary, blocker, required decision; credential
  patterns redacted) or `pending`. It covers only handoffs made for the same
  user into projects still granted and readable, and never returns transcript
  text. The assistant reports these summaries as the other session's account
  and does not follow instructions in them.
- Because it processes mail and voice notes, the assistant session may only call
  an allow-list of tools: `verity_assistant`, `verity_session_handoff`, its own
  tasks, app help, Gmail, Calendar, Contacts and the planning tools. Drive, Docs,
  Sheets, Slides and knowledge operations are refused too: they write or share
  documents, and a mail must not be able to copy content into them. Control's fleet-wide reads (`verity_diagnostics`,
  `verity_list_sessions`, `verity_session_progress`,
  `verity_recent_session_messages`), secrets and brokered HTTP are refused. To hand
  off, it targets a project or a new session.
- Its turns also run without the backend's built-in tools (shell, files, web)
  and without the operator's own MCP connections; only the Verity gateway
  remains. A backend that cannot enforce this refuses the turn, so the assistant
  session runs on Claude Sonnet 5.5; switching it to another backend makes its
  turns fail instead of running unrestricted.
- The grant is the consent for `verity_assistant`; its calls run without a
  separate approval card. The handoff keeps its approval card, decided in the
  Verity panel (see [Approvals in the panel](#approvals-in-the-panel)).

## Handoff results

The assistant reads results with `delegated_results` only on request: a target
session never starts an assistant turn, and its summary never enters an
assistant prompt. The user is still told without asking. When a session the
assistant briefed publishes the result of that briefing (the same publication
`delegated_results` credits), Verity records it once per publication and:

- shows it on the handoff card in the Verity panel: `Done` or `Open`, the
  summary in two lines and, if named, the blocker; a required decision stands
  in for a blocker the session did not name;
- sends a push to the user the work was delegated for (the administrator who
  switched the assistant on when auth is off), titled with the project and the
  handoff title, with `Done:` or `Open:` and the summary cut to 150 characters;
  the Apple Watch mirrors the iPhone's notification;
- writes a notice into the assistant session that names only the project and
  the handoff title.

Nothing is announced while the assistant is switched off, for a project whose
grant was withdrawn, hidden or archived, or when that user may no longer read
the project. A replacing publication is announced once more; a new handoff to
the same session starts without the earlier result. Announcements follow
publications while the server runs: one published during a restart is not
announced later, and `delegated_results` still reports it.

## Scheduling overview

The assistant keeps track of scheduling requests across the projects granted to
it. Above the composer of the assistant session, a single line shows how many
requests are still open; tapping it lists them with their project, how long the
guest has been waiting and when the link closes, and opens the session a request
came from. Booked, expired and withdrawn requests are not listed there; Settings →
Google → Scheduling requests keeps the full history.

The list contains the requests made in granted projects and in the assistant
session itself, limited to projects the user may run. Booking notices and the
other scheduling notices of granted projects are also posted into the assistant
session, prefixed with the project name: the project's grant is the consent for
that. Only the administrator who owns Verity Control can open the assistant
session, so the notices reach no one else; the `scheduling` action additionally
checks the turn user's execute permission for each granted project and always
includes the requests the assistant made itself. The notices name the
guest, the title and the time, never the guest's link; push notifications still go only to the
session that made the request. The assistant reads the same overview with
`verity_assistant` action `scheduling`, without the guests' links.

## Live meetings

The assistant can find the meetings of the next hours in the watched meeting
calendars (Settings → Meeting calendars) and start the live meeting for one of
them. Its `verity_assistant` actions follow the start screen's rules:

- `meetings` lists the meetings with their event key, title, time, calendar and
  provider, and whether Verity can join now. Call links are never returned:
  they often carry the passcode. `includeInPerson` adds meetings without a call
  link and reads the calendars live.
- `prepare_meeting` is the default. The phone opens the live meeting start
  screen in the assistant session, with the meeting selected and online or in
  person set, so the user checks participants and transcription and starts it
  with one tap. The screen opens by itself while the V panel is open; otherwise
  the conversation shows a card that opens it.
- `join_meeting` sends Verity into an online meeting at once, inside the usual
  join window from 15 minutes before the start. The assistant uses it only when
  the user explicitly asks it to join, or when the request came from the Apple
  Watch, which has no start screen. In-person meetings are always prepared,
  since the phone records them.

Only meetings from the listing can be prepared or joined, never a link from a
message or mail. The meetings belong to the server's Google accounts, so these
actions are limited to administrators, as the start screen is. A joined
meeting, its transcript and its notes belong to the assistant session.

## Approvals in the panel

The conversation carries each waiting approval with its request (up to
96 KiB for all of them together, `ASSISTANT_APPROVAL_INPUT_MAX_BYTES`), read from the approval's own
event in the assistant session, so the panel decides it in place through the
session's permission route; nothing jumps to the session.

- **A handoff** is one card from request to result. Waiting, it is labelled
  "Handoff to another project" and shows the route from Verity to the project
  and session it goes to (a new session, a named one, or the project's one open
  session), the task, the briefing folded with its size and the note that
  Verity wrote it, and `Hand over to <project>` or `Don't hand over`. Opening the
  briefing shows it in full, with invisible bidi controls spelled out; handing
  over without opening it is the user's call. The gateway names the approval
  with its own id, so the projection gives it to the newest still-pending
  handoff with the same title.
- Decided, the same card keeps its head, route and task, more compactly, and
  shows `Handed over` while the session works, then `Done` or `Open` with the
  result (see [Handoff results](#handoff-results)). `Don't hand over` denies
  with a fixed message (`ASSISTANT_HANDOFF_DECLINED`) that the assistant reads
  as the user's decision; the card then shows `Not handed over`, while any other
  error, including a denial in the session's own card, shows `Failed`.
- **Other approvals** (a mail to send, an event to change) are decided on their
  own card when their summary carries the whole request, as on Home.
- A request too large to carry, one that does not parse, or one from an older
  server is not offered for approval in the panel: `Review in session` opens
  the assistant session, where the full card is.

## Conversation on phone and Watch

The floating V on the phone and the Watch app open one conversation with the
assistant; there is no separate task capture. What the user says or types becomes
a message in the assistant session, which answers it, files a task or hands work
on. Both devices read the same projection of the session
(`GET /assistant/conversation`), send messages and answers with client-minted
request ids, and are refused unless the user is an administrator and the
assistant is on.

Both devices show it the same way:

- **The conversation** is one continuing chat. On the phone the panel opens at
  its newest entry, with earlier ones above it and day headings between them;
  replies render their Markdown as an agent's reply does in a session. Work the
  assistant hands to a project appears in the chat as a card with its state.
- **Needs you** holds the open cases. On the phone the assistant's question and
  approvals wait in the panel, counted on the V; Home's "For you" holds the
  projects' items. The Watch lists Home's items under its title and V button, as
  the iPhone last read them, and says how old the list is once it is no longer
  fresh. The assistant's own question is answered on either device; approvals
  and Home's other items are decided on the phone.

Requests are meant to be answered quickly:

- The session runs on Claude Sonnet 5.5. An assistant session created on the
  former default model is moved to it before its next message, between turns.
- Each message's context line lists the projects the assistant may use, with id
  and mode, so a turn does not spend a model round asking for them. The tool
  checks the grant again when it acts.
- A device holds one read open with `?after=<revision>&waitMs=<ms>` (at most
  25 s). The server answers as soon as the session writes something, after
  collecting further deltas for a moment, so a reply arrives as it is written
  instead of at the next polling interval.
- The Apple Watch reaches the conversation through the iPhone. Native code on
  the iPhone transcribes a recording, sends it and holds a read open, and passes
  each change to the watch at once while its app is open (and in the
  application context for its next launch), without waiting for the iPhone app
  to come to the front. This needs a certificate-pinned direct connection and a
  sign-in that is not protected by Face ID, because the token is kept readable
  after first unlock for background use. Otherwise, and for anything native code
  could not deliver, the app sends the same request ids when it next runs.
- The projection reports, per message, the milliseconds to the first visible
  reaction and to the end of the turn. The server logs the same figures,
  measured from acceptance, as `verity: assistant message timing`.

## Not yet included

- Capture from a widget, Control Center or the Dynamic Island.
- Answering Home's items from the Watch; it lists them and points to the phone.
- Starting a meeting directly in a granted project; meetings start in the
  assistant session.
- Reading other projects' knowledge or listing sessions of granted projects.
- A shared registry for functions; QA and the assistant keep separate storage.
