# Brokered Secrets — Doppler credential migration

**Status:** Implemented · **Date:** 2026-08-23
**Decision:** [ADR 0009](adr/0009-brokered-secrets-and-secret-job-executor.md)

## Final architecture

All project secret access uses the central Verity broker identity stored encrypted in
`verity_settings.doppler_service_token`. A project stores only its non-secret
`doppler_project` and `doppler_config` mapping.

`verity_http_request`, `verity_secret_run`, Secret Jobs, alias discovery, and the Doppler
project/config pickers resolve through that same broker-owned identity. No Doppler credential,
credential reference, or scoped token is stored for or injected into a project container.

## Migration

Migration `0085_broker_only_doppler_credentials` is intentionally destructive for Doppler
credentials:

- project credentials are recorded durably and cleared per project only after its old container
  has been removed;
- the non-secret minted-token slug is retained as a revocation tombstone until the already-issued
  Doppler token has been centrally revoked;
- externally owned manual credentials remain as unresolved audit tombstones after their runtime
  cutover because Verity has no provider-side revoke identifier for them; external rotation must
  be recorded separately and is never presented as automatically completed;

After the externally owned credential has been rotated, the authenticated maintenance endpoint
`POST /projects/:id/doppler-legacy-remediation` records that fact without accepting or restoring a
credential value. It requires an authenticated device and the fixed, non-secret evidence marker
`{"evidence":"external-credential-rotated"}`; the audit tombstone retains that device identity and
the server request ID.
- provider-binding credential references become `secretref:broker/doppler`;
- encrypted Doppler rows in `secret_provider_credentials` are deleted; credentials and bindings
  for other providers remain unchanged;
- project/config mappings are preserved.

Credentials are never copied or transformed. Legacy Doppler credential environment variables make
server startup fail closed so a deployment cannot silently re-enable the removed path.

Before the upgraded Server exposes its API, it removes every project container associated with a
legacy credential. After the secret store is unlocked, it uses the central broker identity to
revoke each recorded scoped token, recreates the affected container without credentials, and only
then clears the durable cutover row. Revocation or recreation failures remain pending and block
broker resolution; a later broker request retries the idempotent cutover.

## Security boundary

The broker decrypts the central identity only when resolving an approved request, creates an owned
byte buffer for the resolver, and zeroizes it after use. Project runtimes receive only ordinary
non-secret settings such as the default branch and model. Doppler secret values enter only the
approved outbound HTTP request or trusted runner process, with the existing exact-value redaction
and audit controls.

The project settings UI therefore exposes only the Doppler mapping. It has no manual token input,
minted-token status, or claim that credentials are injected into the project.
