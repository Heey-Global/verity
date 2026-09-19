# Direct update recovery for development installations

Use this path when an older Server refuses discovery because it requires rollback
schema compatibility. No bridge release or database reset is required. Recovery
still requires a signed target that can migrate the installed schema.

The target must include `FORWARD_UPDATE_RECOVERY_VERSION = 1`, including the
rollback preflight guard. Never submit a schema-advancing update to an old Updater.

## Verify the target before replacing anything

Run the compiled repository command as root on the deployment host. Provide the
signed `release-envelope.json` and the full running Updater container ID:

```sh
deploy/bin/verity-recover-update --target release-envelope.json \
  --updater-container '<current Updater container ID>' --check
```

This verifies the signature, actual target image metadata, and forward
compatibility before printing the exact `targetImage` digest. It never creates
update intent. An old Updater produces `updaterReady: false`; that does not weaken
target verification and does not authorize applying through the old Updater.
A verification error produces no approved plan: stop there.

## Upgrade only the Updater

Keep the sealed Server image, data volumes, deployment identity, environment, and
mounts unchanged. Wait for any active update to finish. Using the installation's
existing Compose environment and file selection, recreate **only** `verity-updater`
with the digest-pinned new release:

```sh
VERITY_SERVER_IMAGE='<targetImage from the verified check>' docker compose \
  -f deploy/docker-compose.yml -f deploy/docker-compose.managed.yml \
  --profile managed up -d --no-deps verity-updater
```

Use the same additional Compose overlays as the installation. Do not run
`managed-bootstrap`, delete volumes, or recreate the Server. The new Updater reads
the existing sealed deployment and continues to run the old Server until an update
is explicitly admitted. If it fails to start, stop here; do not force an update
through the old Updater. Use only the exact `targetImage` printed by the successful check above.

## Check again and apply

Obtain the replacement Updater's full container ID and repeat the check:

```sh
deploy/bin/verity-recover-update --target release-envelope.json \
  --updater-container '<replacement Updater container ID>' --check
```

Require `updaterReady: true`. The check confirms this deployment's running Updater
is exactly the signed target image with the safety capability. A false result
requires fixing the Updater first; `--apply` refuses it. Recovery currently supports
the initial `verity-managed-server` bootstrap identity; a post-cutover generation
container is refused rather than guessed.

Review the printed deployment ID and digests, then apply the identical plan:

```sh
deploy/bin/verity-recover-update --target release-envelope.json \
  --updater-container '<container ID>' --apply \
  --expected-current '<previousImage>' --expected-target '<targetImage>' \
  --deployment-id '<deploymentId>' --request-id '<unique recovery key>'
```

Admission rechecks the sealed predecessor under the update journal lease. Retrying
uses the same request key. Normal update execution performs preflight, migration,
and cutover. A failed migration does not authorize restarting an incompatible old
Server; the rollback preflight guard leaves recovery stopped when that is unsafe.

This is a prepared host recovery procedure. Unit tests cover admission guards;
a real Docker rehearsal against the affected release is required before claiming
that the installation has been recovered. No installation or release publication
is performed by adding this runbook.
