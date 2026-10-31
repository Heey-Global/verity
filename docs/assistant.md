# Verity assistant

The assistant is the general function of Verity: a persistent session, Verity ·
Assistant, that lives in Verity Control. You reach it by voice note or chat and
it turns short requests into outcomes: an answer, a task in the right project,
or a briefing handed to a project session. QA ([CI supervision](ci-supervision.md))
is a second, specialised function next to it.

## Switching it on

Settings → Assistant holds the installation-wide switch. It is off by default and
only administrators can change it. Turning it on creates the session in Verity
Control (turning it on again recreates a deleted session); turning it off stops
a running turn, keeps the session and its history, and refuses every assistant
tool call until it is on again. Notes already queued still reach the session.

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

## Enforcement

- The assistant session is identified by its stored session id, never by its
  name, the same way QA is.
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
  session is created with the default Claude model; switching it to another
  backend makes its turns fail instead of running unrestricted.
- The grant is the consent for `verity_assistant`; its calls run without a
  separate approval card. The handoff keeps its approval card.

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
that, so anyone who reads the assistant session reads them. The notices name the
guest, the title and the time, never the guest's link; push notifications still go only to the
session that made the request. The assistant reads the same overview with
`verity_assistant` action `scheduling`, without the guests' links.

## Quick capture

When the assistant is on, the capture sheet offers **Verity** next to the
project chips. A note sent there becomes a message in the assistant session
instead of a task; the assistant decides where it belongs. The target is shown
to administrators, who can read the assistant settings. Choosing a project keeps
the previous behaviour.

## Not yet included

- Capture from a widget, Control Center or the Dynamic Island.
- Reading other projects' knowledge or listing sessions of granted projects.
- A shared registry for functions; QA and the assistant keep separate storage.
