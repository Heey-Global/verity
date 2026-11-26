# Attendee live meetings

Live Meeting accepts two transcript sources: local iPhone/iPad speech recognition
for in-person meetings, and audio from Attendee transcribed by the configured
external service for online meetings. Notes, speaker edits,
analysis and research use the existing meeting storage and interface. Requests
addressed to Verity in online meeting audio become saved research hints. You
start their research with the existing Research action; audio never dispatches
an agent turn automatically.

Configure the Attendee API key and base64 project webhook secret in Settings →
Connected services. Both configuration and persisted meeting credentials use the
server's encrypted secret storage. Attendee settings require a configured,
unlocked secret cipher; un-keyed deployments cannot save credentials in plaintext. Removing configuration prevents new meetings;
existing bots retain their credentials until final reconciliation. Set the existing
Transcription settings to an external OpenAI-compatible audio endpoint and model
before starting an online meeting. Configure its token there if needed.

Online meetings require premium Uplink / Online Sharing and negotiated
`webhook-v1` support. A meeting creates its own share before creating a bot. The
share targets a dedicated persistent Core receiver at `/webhooks/attendee`.
The Edge accepts only POST to the configured canonical path, authenticates the
query PIN without cookies or redirects, removes the PIN before forwarding and
preserves the body and signature. A missing-PIN POST returns 401 with
`X-Verity-Webhook-Mode: webhook-v1` without forwarding or spending PIN attempts.
Reserved `/__verity` paths cannot be configured as webhook targets.

Core verifies Attendee's canonical sorted JSON HMAC using the base64-decoded
project secret and stores a durable notification before acknowledging delivery.
A second, meeting-scoped Uplink share forwards the audio WebSocket to a
dedicated loopback receiver. It expires after eight hours and requires both
the share PIN and a meeting-specific token. Verity checks the bot ID on audio
frames. New bots disable Attendee transcription and recording files.

Verity buffers bounded PCM segments in memory and sends them to the configured
audio endpoint. It polls the bot state and publishes completed text on its
ten-second reconciliation cycle. Signed participant events provide names when
available. User speaker edits take precedence. Unavailable audio or failed
transcription produces a gap notice in the transcript.

The app can close while processing continues. Core restores saved bot IDs,
share credentials and completed segments after restart. In-flight audio can
be lost during restart or disconnection. Ending a meeting asks the bot to
leave, drains queued audio within a deadline and revokes both shares. For bots
started before the audio path was added, Core continues to reconcile transcript
snapshots through Attendee's API.

A bot creation timeout remains interrupted until signed metadata identifies
the bot. The audio share is revoked on failed startup. Starting again is
permitted when preparation fails before bot creation was attempted.

Hosted Uplink must explicitly advertise compatible deployed `webhook-v1`
support. Older deployments fail closed. Core's Edge image is built from
`deploy/preview-edge.Dockerfile` by the backend release workflow's
`build-preview-images` and `publish-preview-images` jobs. The published image
reference is recorded in the `verity-preview-edge-image` workflow artifact.
Deployment must use a tested immutable digest; local TypeScript verification is
not deployment evidence. Real Meet validation must include closing and reopening
the app, speaker mapping, final transcript reconciliation and connector restart.

## Unassigned meetings

Core can run an online meeting before anyone has chosen a project, for example
when it joins a calendar meeting on its own ([Calendar meetings](live-meeting-calendar.md)). Such a meeting has no session. Core
keeps transcribing it in its encrypted Attendee state but publishes nothing:
there is no live meeting record, no analysis and no answer to a spoken request
until the meeting is assigned. Requests addressed to Verity wait in the state.

Administrators see unassigned meetings in `GET /live-meetings/active`, next to
the running meetings of every session the caller may read. Unassigned meetings
belong to no project, so like project-less sessions they are visible to
administrators only.

- `POST /live-meetings/unassigned/:meetingId/assign` with `{ "projectId" }`
  creates a session in that project, named after the meeting, and attaches the
  meeting to it. The session id derives from meeting and project, so a retried
  request reuses the session the first attempt created. With `{ "sessionId" }`
  the meeting continues in an existing session instead. Assigning publishes the
  whole transcript so far, then the meeting behaves like one started in that
  session, including waiting spoken requests. A session can still have only one
  running online meeting.
- `DELETE /live-meetings/unassigned/:meetingId` discards the meeting: the bot is
  asked to leave, the transcript is dropped at once and the remaining state is
  deleted once the provider reports the bot ended. Only unassigned meetings can
  be discarded this way; an assigned meeting has already been published.

Unassigned meetings are discarded automatically once they have been over for
the retention period, `unassignedMeetingRetentionDays` in the server settings
(seven days when unset). A meeting that is still running is never discarded by
the retention job.

The app finds running and unassigned meetings through `GET /live-meetings/active`
when it opens and on live refresh. The floating meeting card offers **Assign**,
which picks a project from the recently used ones, and **Discard** after a
confirmation. A session's meeting screen offers **Continue here** for an
unassigned meeting.
