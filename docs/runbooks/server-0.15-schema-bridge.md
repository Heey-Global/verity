# Recover a blocked Server update through a verified bridge

The host command `deploy/bin/verity-recover-bridge` installs a verified intermediate
release through the existing Updater. It works with the Updater shipped in 0.15.1;
it does not require installing a new Server before recovery. Publishing artifacts
and applying an update remain separate actions.

## Prepare and verify the bridge

Server 0.15.1 declares `0097_remove_cross_project_workflows` as its maximum readable
schema. Server 0.16.0 targets `0098_google_workspace_files`. Migration 0098 adds a
non-null `kind` column with a `slides` default to both `session_slide_decks` and
`recent_google_slide_decks`. That additive change does not retroactively extend
the older image's compatibility promise.

Prepare an isolated maintenance branch from `v0.15.1`, commit
`90958b0f7c29e7bc8f3590e4ab9fa9ad697f80ff`. Set `version.txt` and the root entry in
`.release-please-manifest.backend.json` to `0.15.2`. Preserve the migration set
ending at 0097. Build with:

- `VERITY_SERVER_VERSION=0.15.2`
- `VERITY_SCHEMA_FORWARD_MAX=0098_google_workspace_files`

Require the built image's `SERVER_COMPAT` to report version 0.15.2, current schema
0097, and maximum readable schema 0098. Record the exact source SHA, inputs,
architecture and image digest. An environment variable on an existing deployment
cannot substitute for the immutable stamp in this image.

Before publication, test both architectures and both transitions with the full
live smoke profile on an isolated disposable Docker daemon:

1. Released 0.15.1 to the stamped bridge, including health, key handoff and restart.
2. The same bridge digest to 0.16.0, including migration 0098 and failed activation
   followed by rollback to the bridge. Verify that the old application operates
   existing slide assignments and can restart after migration.
3. Negative controls: the direct 0.15.1-to-0.16.0 transition and a bridge without
   its forward stamp must fail compatibility verification.

The SQL regression test proves legacy writes and defaults. It does not replace
this live application and rollback proof. The mandatory image compatibility gate
cannot be bypassed with the no-rollback override.

Publish the reviewed bridge through the maintenance workflow with
`backend-artifact-only=true`, `backend-version=0.15.2`,
`backend-ref=<reviewed full source SHA>`,
`backend-schema-forward-max=0098_google_workspace_files`,
`backend-republish=false`, and `backend-accept-no-rollback=false`.
The existing draft **release** must target that exact SHA. Pull requests are
review-ready, never drafts. Artifact-only publication retains signed release
evidence without promoting mutable channel tags or marking the bridge latest.

## Obtain the signed recovery evidence

Download the architecture-specific metadata and Sigstore bundle from the official
GitHub releases for both the bridge and its intended successor. The asset names
are `verity-server-v<VERSION>.<ARCH>.release-channel.json` and
`verity-server-v<VERSION>.<ARCH>.release-channel.sigstore.json`, where `<ARCH>` is
`amd64` or `arm64`. Repository access may be needed to download the assets; no
repository credential is passed to the recovery command.

Artifact-only publication also attaches the complete signed envelope as
`verity-server-v<VERSION>.<ARCH>.release-envelope.json`. Use that file directly
as `bridge.json`. For an older successor release that only carries separate
metadata and bundle assets, assemble its envelope without parsing or rewriting
the signed metadata bytes:

```sh
node --input-type=module - <<'JS' > successor.json
import { readFileSync } from 'node:fs';
process.stdout.write(JSON.stringify({
  payload: readFileSync('verity-server-v0.16.0.amd64.release-channel.json').toString('base64'),
  signature: {
    kind: 'sigstore-bundle',
    bundle: readFileSync('verity-server-v0.16.0.amd64.release-channel.sigstore.json').toString('base64'),
  },
}));
JS
```

Use the matching ARM64 assets on ARM64 hosts. Locally fabricated metadata or an
unsigned image will not pass. The command uses the existing official Sigstore
verifier, including workflow identity, repository identity, certificate chain,
transparency evidence, and the revision bound into the signed metadata.

## Review the recovery plan

Use a reviewed checkout of this recovery implementation with its locked
dependencies and compiled packages (`npm ci --ignore-scripts`, `npm run build`).
Run the command as root on the deployment host, using a trusted checkout and Node
executable. It uses only the local Docker daemon at `/var/run/docker.sock`, the
existing managed deployment volume, and the existing Updater control volume.
Remote Docker contexts and arbitrary deployment-root overrides are not supported.

```sh
sudo deploy/bin/verity-recover-bridge \
  --bridge bridge.json --successor successor.json --check
```

Check mode validates the current managed deployment and running image, verifies
both signatures and both compatibility transitions, and pulls/probes the signed
bridge digest in an isolated container without network, mounts or capabilities.
It may populate the Docker image and Sigstore trust caches. It does not create an
update operation or change the installed release.

The JSON plan names `deploymentId`, `previousImage`, `bridgeImage`, and the intended
successor. The bridge must have a higher version than the installed Server,
preserve its current schema, and promise compatibility with the successor. The
bridge's actual image contract must exactly match its signed metadata.

## Apply the reviewed plan

Supply the exact deployment ID and both image digests printed by check mode, plus
a request key for this attempt:

```sh
sudo deploy/bin/verity-recover-bridge \
  --bridge bridge.json --successor successor.json --apply \
  --deployment-id '<deploymentId>' \
  --expected-current '<previousImage>' \
  --expected-bridge '<bridgeImage>' \
  --request-id bridge-0.15.2-attempt-1
```

Apply repeats verification. Under the Updater's existing single-writer journal
lease, it checks that the deployment still matches the verified predecessor and
refuses competing updates. It creates normal durable update intent and submits
the same request key and digest to the existing authenticated Updater API. That
Updater owns image verification, preflight, migration, cutover and rollback.
Sealed deployment state, channel anti-regression state and database contents are
not rewritten by the recovery command. Credentials remain local and are not
printed or placed in subprocess arguments.

The command returns the accepted operation, not a claim that cutover finished.
Use Maintenance in the paired app to observe completion. If submission was
interrupted, retry the identical command and request key: it reuses the reserved
operation. A changed deployment is refused. After a terminal failed or rolled-back
attempt, inspect the failure before checking again and using a new request key.
After the bridge completes, the normal signed update channel can offer 0.16.0.

## Why this is a separate host recovery action

The stable channel describes one release, not a sequence of intermediates.
A 0.15.1 process that has already seen 0.16.0 rejects a lower channel version even
when 0.16.0 was incompatible. Temporarily replacing stable with 0.15.2 also misses
installations that were offline during that window. Explicit host recovery checks
that the bridge advances the *installed* version without changing global channel
state or weakening normal discovery's anti-regression rule.

The installer deliberately refuses `--update` on paired deployments. Do not use
`--reinstall`, change filesystem permissions on managed state, or edit its sealed
image selection to force this transition. The recovery command fails closed when
it cannot access or validate the existing root-owned deployment and Updater.
