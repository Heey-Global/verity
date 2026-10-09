# Attendee live meetings

Live Meeting accepts two transcript sources: local iPhone/iPad speech recognition
for in-person meetings, and Attendee for online meetings. Notes, speaker edits,
analysis and research use the existing meeting storage and interface. Requests
addressed to Verity in online meeting audio become saved research hints. You
start their research with the existing Research action; audio never dispatches
an agent turn automatically.

Configure the Attendee API key and base64 project webhook secret in Settings →
Connected services. Both configuration and persisted meeting credentials use the
server's encrypted secret storage. Attendee settings require a configured,
unlocked secret cipher; un-keyed deployments cannot save credentials in plaintext. Removing configuration prevents new meetings;
existing bots retain their credentials until final reconciliation.

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
Every ten seconds, it fetches the bot state and full transcript snapshot. Full
snapshots replace text instead of appending webhook payloads, avoiding duplicate
lines and retaining provider corrections. Provider speaker identities map to
stable local speaker numbers. User speaker edits take precedence.

The app can close while processing continues. Core restores saved bot IDs and
share credentials after restart. Ending a meeting requests that the bot leave;
Core reconciles the terminal transcript before removing the share and erasing
per-meeting credentials. Shares have a fixed 30-day safety ceiling, not a
meeting timer. Control lease renewal does not renew this ceiling.

If a share expires, Core keeps recovering text through Attendee's API. It does
not promise callback replacement or replay of transient provider events. A bot
creation timeout remains interrupted until its signed metadata identifies the
bot; it must not silently create a duplicate. Starting again is permitted when
preparation fails before bot creation was attempted.

Hosted Uplink must explicitly advertise compatible deployed `webhook-v1`
support. Older deployments fail closed. Core's Edge image is built from
`deploy/preview-edge.Dockerfile` by the backend release workflow's
`build-preview-images` and `publish-preview-images` jobs. The published image
reference is recorded in the `verity-preview-edge-image` workflow artifact.
Deployment must use a tested immutable digest; local TypeScript verification is
not deployment evidence. Real Meet validation must include closing and reopening
the app, speaker mapping, final transcript reconciliation and connector restart.
