# Matrix knowledge connector

## Goal and boundary

A dedicated Matrix account joins selected rooms bridged from WhatsApp or Signal. Verity imports new text messages into the assigned project's Knowledge only after a person pairs the room with a project. A room belongs to at most one project; a project may have many rooms. The connector does not send messages back to Matrix.

This is an inbound integration. It does not run through an agent session or MCP. Agent tools may later read imported knowledge, but an agent must never treat chat content as instructions.

## Integration contract

Keep account setup, source discovery, project binding, and ingestion separate:

- An **integration account** identifies an external service and holds server-side credentials and health state. Matrix has one homeserver URL, user ID, access token, and persistent crypto store per account. The app sends the password when it is saved; subsequent reads return only whether a password is configured. Device keys remain in the worker's persistent store.
- A **source** is an external stream discovered by the account. For Matrix it is a stable room ID, with display name and inviter as untrusted metadata. An invitation is a pending source, not permission to ingest.
- A **binding** connects one source to a Verity project. It records the activation time, enabled state, import status, and the account/source IDs. The server owns this mapping; the connector cannot select a target project from message content.
- An **ingest event** has a provider event ID, source ID, sender, origin timestamp, kind, and bounded content. The server accepts it only for an active binding. `(account_id, source_id, event_id)` is unique, making retries idempotent.

Future providers such as Gmail can reuse accounts, sources, bindings, status, and the ingest authorization boundary. Their discovery and event processing stay provider-specific; there is no generic E2EE or email parser interface.

## Runtime

Run the Matrix worker as a separate service on the Verity side of the Tailnet. The implementation is in `connectors/matrix`: it uses the Matrix Rust SDK, with an encrypted persistent SQLite crypto store and a private session file. Its data directory must be a persistent volume. Account password, store passphrase, and connector token are deployment secrets, never mobile settings or repository files.

Build its image from the repository root with `docker build -f connectors/matrix/Dockerfile -t verity-matrix-connector:local .`. The optional `connectors/matrix/compose.yml` overlay wires the reference Verity Compose service and a persistent `/data` volume; run it alongside `deploy/docker-compose.yml`. Configure the Matrix homeserver URL, account ID, and password once in Verity Settings → Connected services → Matrix → Matrix account in the app. Configure only `MATRIX_STORE_PASSPHRASE`, `VERITY_INTERNAL_URL`, and `VERITY_MATRIX_CONNECTOR_TOKEN` as deployment secrets/configuration. The same random connector token (at least 32 characters) must reach both services. `VERITY_INTERNAL_URL` must reach Verity's internal listener when that listener is enabled. If its HTTPS certificate uses a private CA, mount that CA certificate into the worker and set `VERITY_CA_CERT_PATH`. The Matrix URL must use HTTPS; for a Tailscale ingress use its hostname so TLS verifies normally. Run one worker replica per Matrix account and keep its `/data` volume across updates.

The worker syncs invitations and joined-room events. It may show pending invitations in Verity before joining, but it does not accept or import one until the room has a project binding. On activation, it joins, establishes E2EE, and imports messages from that point forward. It must expose undecipherable events and failed syncs as explicit status rather than silently skipping them.

The worker writes events into a private on-disk outbox before forwarding them. The server stores each event under a unique `(account_id, source_id, event_id)` key, then rewrites the affected Knowledge source. A restart can retry queued events without duplicating entries. If Verity is temporarily unavailable, the outbox keeps events for retry.

## Knowledge projection

Write one Markdown source per room and day under `sources/documents/matrix/`, using a hash of the account, stable room ID, and binding activation time in the path and a date in the filename. A later reconnection therefore cannot overwrite an earlier project's source. Each entry carries a timestamp, sender, event ID, and quoted body. Messages over 8,000 characters carry a visible truncation marker. The header says that participants' messages are untrusted external content.

An edit replaces the affected entry in the current projection. A redaction removes its body from the current projection and records that it was redacted. Previous Knowledge versions and backups follow Verity's normal retention rules; changing the current projection does not erase them.

Initial scope is text after activation. Attachments, voice messages, reply threading, history backfill, automatic summaries, and outbound replies are separate features.

## Settings and project flow

Verity Settings → **Connected services** → **Matrix** shows an overview of invited and connected rooms. Open **Matrix account** there to enter the homeserver URL, account ID, and password once for the server. The server stores the password encrypted and returns only whether one is configured. A single Matrix account serves all projects. Each project's settings has a separate **Integrations** destination for room assignment. A pending invitation can be connected to that project, which permits the worker to join. That project page lists its connected rooms with last import, pause, and disconnect actions. Pause defers queued imports until resumed. Disconnect prevents new ingestion and leaves existing Knowledge available until explicitly removed. Changing the account identity requires resetting the worker's persistent device store and room bindings; updating its password is allowed.

Server routes for settings use paired-device authentication. Worker routes use a separate credential limited to listing its own bindings and submitting events for them. The worker cannot call general Knowledge APIs or assign a room to a project. The server validates event size, type, room membership, and binding state before writing.

## Verification gate

Before enabling a room, test an encrypted bridged room end to end: invitation appears, project binding causes join, a new message appears in Knowledge, a restart preserves decryption and avoids duplicates, and an edit/redaction changes the current source. A deliberately broken binding must reject ingestion. The live test requires a dedicated Matrix account and a test room; no credentials belong in the repository.
