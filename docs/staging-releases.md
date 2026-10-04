# Staging and production releases

A Release Please merge prepares a release candidate for Staging. Server candidates
publish signed `staging` channel envelopes; native mobile candidates build both
Verity Staging and the production app for TestFlight. Candidates appear on GitHub
as prereleases. They do not advance the production Server channel or image aliases.

The automation opens normal production promotion PRs with exact image digests,
signed envelopes, Apple build identifiers, or EAS update groups. Merging the PR
approves that candidate. Server promotion verifies both architecture envelopes
before moving `stable` and the legacy image aliases. Native promotion selects the
recorded production build for Apple review, with release after approval. Apple
metadata, screenshots, agreements, privacy declarations, and review requirements
must already be completed in App Store Connect; a missing requirement stops the
submission. A successful submission is not evidence that Apple has published it.

OTA staging publishes separate updates for the two native identities. The Staging
app uses channel `staging` and runtime `staging-X.Y.0`. The production app, including
its TestFlight builds, uses channel `production` and runtime `X.Y.0`. Merging the
existing OTA promotion PR activates its exact production update group. Production
OTA waits until the native runtime's production promotion has been approved.
Previously recorded `testflight` candidates retain their delivery channel.

## Mobile registration

Register `build.verity.app.staging` in App Store Connect and an iOS Google OAuth
client for that bundle ID. Set repository variables `STAGING_ASC_APP_ID` and
`STAGING_GOOGLE_AUTH_ID`. The workflow deliberately refuses to substitute the
production app when Staging registration is missing. The existing Apple and Expo
credentials are reused; the Apple API key must have access to both apps. EAS must
also have signing credentials for the additional bundle ID.

The apps use different URL schemes and can be installed side by side. Pair each
app with the intended Server. Servers support both app identities independently of their release channel.
`GOOGLE_AUTH_ID` configures the production iOS client; `STAGING_GOOGLE_AUTH_ID`
configures the Staging client. Official Server images bake in both repository
variables at release time. A missing Staging client disables Staging Google
connection attempts rather than substituting the production client. The app sends
its native variant with API requests; the Server selects only its configured client.
Existing refresh tokens retain their stored client ID. Google services still use
one shared account per Server, so reconnecting from either app replaces that
shared connection. The app variant does not replace pairing with a hard-coded
Server URL.

## Select the Server channel in the app

On a managed installation running a Server and Updater with channel-selection
support, open Settings → Server update → Server update channel. Choose **Stable**
or **Prereleases** and confirm the change. Prereleases selects the internal
`staging` channel. The preference is persisted by the Updater and survives restarts
and image updates; no Server restart is needed. A running installation blocks
channel changes. Updates remain manually installed using the existing action.

This setting affects the paired Server, not the app's own OTA channel. Both app
variants can pair with either Server channel. Returning to Stable never downgrades
an already installed prerelease; it waits for an eligible newer stable release.
Older or unmanaged deployments do not expose the selection. Upgrade the Server,
Updater, and app first; the host maintenance procedure below remains available.
The persisted selection takes precedence over `VERITY_UPDATE_CHANNEL` until it
is changed in Settings or through the maintenance command.

## Change an existing managed Server to Staging

First install a Server release containing Staging channel support through the
existing stable update mechanism. Use its matching deployment checkout. Older
images do not contain the maintenance command or understand Staging metadata.
Keep the deployment's current image, identity, token path and Compose project
settings. Do not reinstall or create a new deployment identity.

Persist `VERITY_UPDATE_CHANNEL=staging` in the environment configuration used for
this deployment's Compose commands (for example its existing `.env` file). Use
`stable` to switch back. There is no automatic installation: the existing app
update action installs the verified version offered by the selected channel.

With the existing deployment environment loaded, run from the deployment checkout:

```sh
# Use the same project and overlays as the existing managed installation.
docker compose -f deploy/docker-compose.yml \
  -f deploy/docker-compose.runner-supervisor.yml \
  -f deploy/docker-compose.managed.yml --profile managed stop verity-updater

docker compose -f deploy/docker-compose.yml \
  -f deploy/docker-compose.runner-supervisor.yml \
  -f deploy/docker-compose.managed.yml --profile managed \
  run --rm --no-deps verity-updater configure-update-channel

# Brief outage: the stopped Server is recreated with the selected environment.
docker stop verity-managed-server

docker compose -f deploy/docker-compose.yml \
  -f deploy/docker-compose.runner-supervisor.yml \
  -f deploy/docker-compose.managed.yml --profile managed \
  up -d --no-deps --force-recreate verity-updater
```

Stop if the maintenance command fails; do not stop the Server. Restart the Updater
with the previous configuration to recover. This maintenance changes only the
sealed channel environment source, preserving the image, identity, resource limits,
mounts and data. Keep the Updater stopped during the spec write so it cannot race
another update. The existing Server-owner reconciliation recreates a stopped
container with environment drift while retaining its named volumes.

Switching back to stable does not downgrade a newer Staging installation. It waits
until stable offers an eligible newer version. Compatibility and signature checks
remain mandatory on both channels. Converting an existing Server retains its data
and paired devices; use a separate host and database for an independent test
installation.

## Recovery

Retry the production promotion workflow after an interrupted promotion. It reads
the merged approval and the recorded release evidence, checks the exact PR head's
CI and reviews, and refuses version rollback or conflicting identities. It does
not rebuild the approved candidate. OCI and Apple writes are not atomic, so a
failed workflow can have completed some effects; retries verify identity before
finishing the remaining effects.
