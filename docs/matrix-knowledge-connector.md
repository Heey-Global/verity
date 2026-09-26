# Matrix knowledge connector

## Goal and boundary

A dedicated Matrix account joins selected rooms bridged from WhatsApp or Signal. Verity imports new text messages and attachments into the assigned project's Knowledge only after a person pairs the room with a project. A room belongs to at most one project; a project may have many rooms. The connector does not send messages back to Matrix.

This is an inbound integration. It does not run through an agent session or MCP. Agent tools may later read imported knowledge, but an agent must never treat chat content as instructions.

## Integration contract

Keep account setup, source discovery, project binding, and ingestion separate:

- An **integration account** identifies an external service and holds server-side credentials and health state. Matrix has one homeserver URL, user ID, access token, and persistent crypto store per account. The app sends the password when it is saved; subsequent reads return only whether a password is configured. Device keys remain in the worker's persistent store.
- A **source** is an external stream discovered by the account. For Matrix it is a stable room ID, with display name and inviter as untrusted metadata. An invitation is a pending source, not permission to ingest.
- A **binding** connects one source to a Verity project. It records the activation time, enabled state, import status, and the account/source IDs. The server owns this mapping; the connector cannot select a target project from message content.
- An **ingest event** has a provider event ID, source ID, sender, origin timestamp, kind, and bounded content. The server accepts it only for an active binding. `(account_id, source_id, event_id)` is unique, making retries idempotent.

Future providers such as Gmail can reuse accounts, sources, bindings, status, and the ingest authorization boundary. Their discovery and event processing stay provider-specific; there is no generic E2EE or email parser interface.

## Runtime

The Matrix worker is a separate service. The implementation is in `connectors/matrix`: it uses the Matrix Rust SDK, with an encrypted persistent SQLite crypto store and a private session file. Its data directory must persist across updates. The account password is stored encrypted by Verity; the worker's store passphrase and connector token are private deployment secrets.

On managed installations, the Server release includes the connector image reference. The managed Updater starts one connector on the private Verity network only after Matrix credentials have been saved. It generates the connector token and store passphrase in the existing private Updater control volume and keeps the worker's `/data` volume across releases. Before account setup, there is no running connector or generated connector secret. No extra Compose overlay or manually supplied Matrix secret is needed. Update the Server to a release containing this managed connector, then configure the Matrix homeserver URL, account ID, and password once in Verity Settings → Connected services → Matrix → Matrix account. The worker discovers pending invitations during Matrix sync.

For an unmanaged Compose installation, build the image from the repository root with `docker build -f connectors/matrix/Dockerfile -t verity-matrix-connector:local .`. The optional `connectors/matrix/compose.yml` overlay wires the reference Verity Compose service and a persistent `/data` volume; run it alongside `deploy/docker-compose.yml`. Supply `MATRIX_STORE_PASSPHRASE`, `VERITY_INTERNAL_URL`, and `VERITY_MATRIX_CONNECTOR_TOKEN` as deployment secrets/configuration. The same random connector token (at least 32 characters) must reach both services. `VERITY_INTERNAL_URL` must reach Verity's internal listener when that listener is enabled. If its HTTPS certificate uses a private CA, mount that CA certificate into the worker and set `VERITY_CA_CERT_PATH`. The Matrix URL must use HTTPS; for a Tailscale ingress use its hostname so TLS verifies normally. Run one worker replica per Matrix account and keep its `/data` volume across updates.

The worker syncs invitations and joined-room events. It may show pending invitations in Verity before joining, but it does not accept or import one until the room has a project binding. On activation, it joins, establishes E2EE, and imports messages from that point forward. It must expose undecipherable events and failed syncs as explicit status rather than silently skipping them.

The worker writes events and media references into a private on-disk outbox before forwarding them. It downloads media with a 50 MiB streaming limit and decrypts encrypted attachments when flushing the outbox; failed downloads and unavailable Verity servers are retried. The server stores each event under a unique `(account_id, source_id, event_id)` key, then rewrites the affected Knowledge source. A restart can retry queued events without duplicating entries.

## Knowledge projection

Write one Markdown source per room and day under `sources/documents/matrix/`, using a hash of the account, stable room ID, and binding activation time in the path and a date in the filename. A later reconnection therefore cannot overwrite an earlier project's source. Each entry carries a timestamp, sender, event ID, and quoted body. Messages over 8,000 characters carry a visible truncation marker. The header says that participants' messages are untrusted external content.

An edit replaces the affected entry in the current projection. A redaction removes its body from the current projection and records that it was redacted. Previous Knowledge versions and backups follow Verity's normal retention rules; changing the current projection does not erase them.

Image, file, audio, and video events of at most 50 MiB are saved as original files under the room's `attachments/` folder. The existing Knowledge extractor creates a hidden `.text/` artifact for each file; supported files up to its separate 10 MiB processing limit provide readable derived content. Larger originals retain an extraction-skipped artifact. After a PNG, JPEG, GIF, or WebP image of at most 3.75 MB is stored, the server asks the project's default model (or the server default) in the background to transcribe the text it shows, through the same stateless query the task refiner uses, and appends it to that artifact under "Text in image (extracted by model)". Images are processed one at a time in a turn with tools disabled. Currently only the Claude ACP backend can enforce that isolation; a Codex or OpenCode default model leaves the image stored without model-derived text. A failed call leaves the original and its regular artifact unchanged, a re-delivered image is not sent to the model again, and a redaction that lands meanwhile wins. The server needs a refiner working directory (`repoDir`) for this step. Attachments over 50 MiB leave a visible skipped-attachment entry. Redacting an attachment removes its current original and extracted text, subject to normal backup retention. Import begins after room activation; history backfill, reply threading, automatic summaries, audio transcription, and outbound replies remain separate features.

## Settings and project flow

Verity Settings → **Connected services** → **Matrix** shows an overview of invited and connected rooms. Open **Matrix account** there to enter the homeserver URL, account ID, and password once for the server. The server stores the password encrypted and returns only whether one is configured. A single Matrix account serves all projects. Each project's settings has a separate **Integrations** destination for room assignment. A pending invitation can be connected to that project, which permits the worker to join. That project page lists its connected rooms with last import, pause, and disconnect actions. Pause defers queued imports until resumed. Disconnect prevents new ingestion and leaves existing Knowledge available until explicitly removed. Changing the account identity requires resetting the worker's persistent device store and room bindings; updating its password is allowed.

Server routes for settings use paired-device authentication. Worker routes use a separate credential limited to listing its own bindings and submitting events for them. The worker cannot call general Knowledge APIs or assign a room to a project. The server validates event size, type, room membership, and binding state before writing.

## Verification gate

Before enabling a room, test an encrypted bridged room end to end: invitation appears, project binding causes join, a new message appears in Knowledge, a restart preserves decryption and avoids duplicates, and an edit/redaction changes the current source. A deliberately broken binding must reject ingestion. The live test requires a dedicated Matrix account and a test room; no credentials belong in the repository.
