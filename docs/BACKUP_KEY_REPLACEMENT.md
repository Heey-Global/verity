# Backup recovery-key replacement

Recovery-key replacement is an administrator-only operation. The app's "Create new
recovery key" always uses `lost`; `exposed` stays an API-only path for an
administrator who also rotates the identity. It does not rotate the installation's
TLS or pairing identity; use the installer identity rotation procedure for that purpose.

1. `POST /api/backups/key-replacement` with `{"reason":"lost"}` or
   `{"reason":"exposed"}` returns an in-memory candidate ID and a new recovery key.
   Save the key outside the server. No backup configuration changes at this point.
2. Confirm with `POST /api/backups/key-replacement/confirm`, supplying `id` and
   `recoveryKey`. Confirmation validates the key against the candidate, records a durable
   intent containing only host signing material and public encryption recipients, and
   publishes a separate repository and key generation. Historical repositories remain
   encrypted to their original key.
3. Before confirmation, `POST /api/backups/key-replacement/cancel` discards the
   candidate without changing the configuration. Confirmed operations cannot be cancelled:
   retry the same confirmation ID or restart the service to resume publication. Capture
   and policy updates complete the pending transition before using the configuration.

For a lost key, historical backups remain readable with the original key if it is
recovered. The new key does not decrypt them. Keep any remaining original key material
until its backups expire.

For an exposed key, the root identity helper first persists a generation tombstone,
removes the exact local encrypted CA bundle for that installation and generation,
and acknowledges the deletion. It rejects subsequent attempts to publish to the retired
generation, including replayed requests after restart. A failed CA publication leaves
the confirmed replacement pending for retry. Unrelated files are preserved. This does
not delete external copies or revoke trust already stored on offline devices. Exposure
therefore also requires installation identity rotation and deliberate device re-pairing.

Device revocations are published to all catalogued key generations before the database
outbox event is acknowledged, so replacing a key does not leave historical snapshots
without later device revocations.

The targeted tests exercise cancellation, failure and restart, exposure ordering,
independent generation credentials, cross-generation device revocations, retirement
replay and protection of unrelated files. The shell fixture simulates root ownership
and Docker; it executes the actual filesystem deletion, synchronization and locking.
It does not establish a real privileged-host acceptance result. Deliberate mutations
and restored source/test digests are recorded in `backup-key-replacement-mutations.json`.
