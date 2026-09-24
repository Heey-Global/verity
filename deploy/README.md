# Verity runner — install guide

The **Verity runner image** is the single container an operator installs to run
the Verity control-plane on any Docker host. It is **API-only**: the compiled
Fastify server plus the `docker` CLI and `git` it needs to clone repos and spawn
project containers. The [Expo mobile app](../apps/mobile) is the client — you
configure everything (master password, GitHub App credentials, projects) from
there.

The published image is produced by `.github/workflows/release.yml` after its
release-please PR is deliberately merged. It is tagged with a v-prefixed shared
SemVer version (`v3.28.0` format), an immutable `sha-<short>` rollback tag, and
the mutable `latest` channel tag.

The same tag policy applies to the `verity-sandbox` image and
`verity-sandbox-toolkit` OCI artifact: each publish keeps a stable SemVer tag and
updates the mutable `latest` channel tag.

This packaging is **ADR 0003 — Verity Runner Image & Deployable Packaging**,
Phase A (the ADR lands with PR #303).

## Prerequisites

- A Docker host with **Docker 25.0+** (the provisioner mounts per-project subdirs
  of a named volume into sibling sandboxes via `volume-subpath`) and the **Compose v2
  plugin** (`docker compose`; the standalone `docker-compose` binary is not used).
- An **amd64** or **arm64** Linux host. Both architectures receive the Server,
  sandbox, toolkit, relay, preview images, and signed self-update channel.
- Brokered Secret jobs and project Sandboxes are supported on **amd64 and arm64** and require the
  pinned gVisor host runtime, registered twice (`runsc`, `runsc-project`). `verity-install` installs
  and registers it through the host component `verity-host-runtime`; see
  [`deploy/gvisor`](gvisor/README.md). The Compose wrapper always runs a real `runsc` and
  `runsc-project` preflight before every deployment change.

A release declares the runtimes it needs (the `org.verity.host-runtimes` image label). Before the
managed Updater creates a candidate, it compares that declaration with what Docker reports and, when
the host lacks something, asks `verity-host-runtime` to register it and verifies the result. If that
is not possible the update fails as `host-runtime-failed` before anything is activated, and the
current generation keeps serving. The candidate's own `/healthz` does not guard this: the readiness
probe accepts a `degraded` 503 on purpose. A host installed before the host component existed is
told to re-run the Verity installer (the Quick start command below) once; no insecure compatibility mode is available.

That's it — Verity's data lives on the Docker-managed `verity-data` volume, which
the daemon creates on first use and initializes with the right owner (the image
pre-creates `/srv/verity` as uid 1000). There is **no host directory to create or
`chown`**.

## Quick start

For a fresh managed installation, the recommended path is:

```sh
curl -fsSL https://verity.build/install.sh | bash
```

The public bootstrap pulls the official release, resolves it to an immutable
digest, copies the release-matched deployment bundle into a fresh root-owned
directory, and runs the guarded installer below. The temporary bundle is removed
afterwards; durable deployment identity remains under `/etc/verity`. It requires
Docker 25+, Compose v2, and root access through either the current account or
`sudo`. The privileged installer deliberately uses the root Docker daemon;
Rootless Docker is not accepted as a source for code that will execute as root.

Every run starts with an aggregated host preflight and reports all missing
requirements before pulling an image or changing installation state. To run only
that check, or to let the bootstrap install missing `tar`, `flock`, OpenSSL, `curl` and `jq` packages through
a supported host package manager, use:

```sh
curl -fsSL https://verity.build/install.sh | bash -s -- --preflight
curl -fsSL https://verity.build/install.sh | bash -s -- --install-missing
```

The package opt-in never installs or reconfigures Docker or Compose; those remain
explicit host prerequisites.

For a host-managed or development deployment from a checkout:

```sh
export VERITY_SERVER_IMAGE=<verity-server-image@sha256:digest>
sudo install -d -m 0711 -o root -g root /etc/verity
sudo ./deploy/bin/verity-pairing-material
./deploy/bin/verity-compose up -d
```

That's it — the API comes up on port **8082**. Verify:

```sh
curl --insecure https://localhost:8082/healthz    # -> {"status":"ok"}
```

To run a second clean runner next to an existing Verity dev/dogfood stack, give
it a different Compose project and host port:

```sh
VERITY_API_HOST_PORT=8090 \
VERITY_PAIRING_STATE_HOST_PATH=/etc/verity-onboarding \
./deploy/bin/verity-compose -p verity-onboarding up -d --build
```

Create pairing material in `/etc/verity-onboarding` first, with
`VERITY_STATE_DIR=/etc/verity-onboarding VERITY_API_HOST_PORT=8090`. Then scan
the generated URI in the mobile app. This is the same runner image
and first-run flow, just with independent DB/data state from the default stack:
the `-p verity-onboarding` Compose project namespaces its own `verity-db` and
`verity-data` volumes (and its own `postgres` container), so the two stacks never
share a database or a data root.

If the runner configuration is stored in Doppler, the Compose start can be one
line. Put values such as `VERITY_API_HOST_PORT` in the Doppler config, then run:

```sh
doppler run --project verity --config onboarding -- \
  ./deploy/bin/verity-compose -p verity-onboarding up -d --build
```

The `verity-data` volume is created and initialized by Docker on first start — no
host directory to prepare.

## First-run setup (in the app)

The installer creates a stable local TLS/server identity and a short-lived pairing
capability under `/etc/verity`. On first run, in the mobile app:

1. Choose one of the detected IP addresses, or enter a DNS name, when prompted by
   `verity-install`. Then scan its QR code in the app, or copy the complete pairing
   code printed below it and choose **Paste pairing code instead**. The app verifies
   both the pinned TLS certificate and the stable signed server identity.
2. **Set or unlock the master password.** This derives the at-rest encryption key for DB
   secrets (ADR 0002 D3). The secret store starts sealed until you do this — the
   server logs `secret store is UNINITIALIZED and SEALED` on boot, which is
   expected.
3. **Enter your GitHub App credentials** (App ID, private key) and signing key.
   These are encrypted and stored in the DB — no host-mounted `.pem`.
4. **Add a project** by naming its repo. Verity clones it into the clone-root and
   runs a container from the standard base image; the agent is ready.

### Pair another device

After the first device is set up, open **Settings → Paired devices → Pair another
device**. Verity creates a five-minute, one-use invitation. Scan its QR code on a
phone or tablet, or copy and paste the pairing link into the iPad app running on a
Mac. Each device receives its own bearer token and can be removed independently
from the same screen. The master password is never included in the invitation.

The master password is the only way to unlock the secret store — there is no
env-key/headless auto-unlock. On restart the store comes up sealed and is
unlocked from the app; run the first-time onboarding on a trusted network until
the password is set.

> **Upgrading from an old `VERITY_SECRET_KEY` deployment:** that env-key mode has
> been removed. A store whose secrets were encrypted under `VERITY_SECRET_KEY`
> boots sealed and uninitialized, and setting a master password derives a
> _different_ key — so those secrets do not auto-decrypt. Re-enter the GitHub App
> credentials + signing key through the app after upgrading (there is no in-place
> re-key yet).

> **Project-relay cutover prerequisite:** this release removes the shared-network
> and direct broker fallback. Before checking out or deploying this release,
> enable the relay overlay from the currently deployed release, let its migration
> reconciler converge, and run its cutover check. Proceed only when it reports
> `READY`. A busy legacy sandbox must finish its turn and migrate before the
> upgrade. The new server deliberately does not restore legacy TCP access during
> rollout.

## Migrate to managed Server updates

The default quick start remains host-managed. To adopt an existing official,
digest-pinned deployment for app-initiated Server updates, run the installer:

```sh
sudo deploy/bin/verity-install
```

It resolves the current release, generates a stable deployment identity and a
random control token in a root-owned `0600` file, persists both under `/etc/verity`,
and hands over to the guarded migration described below. `--check` runs the
preflight and prints what it would install without touching the deployment.

Because it persists every decision, later recovery runs take no arguments; see
[the companion handoff recovery path](#after-an-update-companion-handoff).
When an interactive run detects an existing installation, it offers three explicit
paths: repair the current release without changing data, update an installation that
has not paired its first device yet, or completely replace it. A paired deployment
updates from the Verity app; the host-side `--update` path is fenced off after pairing.

When a paired installation cannot reach a newer schema through the update channel,
use the [verified schema-bridge recovery procedure](../docs/runbooks/server-0.15-schema-bridge.md).
`deploy/bin/verity-recover-bridge` checks signed intermediate-release evidence and
submits an explicitly approved recovery operation to the existing Updater.

To discard an installation and all of its data, run:

```sh
sudo deploy/bin/verity-install --reinstall
```

The installer requires the exact phrase `DELETE VERITY` before removing containers,
volumes, network, database, projects, sessions, stored secrets, pairing identity, and
installer state. Automation can make the same destructive choice explicitly with
`--reinstall --yes`. After cleanup, the command immediately performs a fresh install.

The Runner supervisor is always enabled because Claude is ACP-only. Its capability is
sealed into the deployment spec; installations previously sealed without it must be
reinstalled before they can be updated.

To assemble the same inputs by hand, create the identity and the token yourself and
call the guarded migration directly:

```sh
sudo install -d -m 0700 -o root -g root /etc/verity
sudo sh -c "umask 077; dd if=/dev/urandom bs=32 count=1 2>/dev/null | od -An -tx1 | tr -d ' \\n' > /etc/verity/updater-token"
export VERITY_SERVER_IMAGE=ghcr.io/heey-global/verity/verity-server@sha256:<digest>
export VERITY_MANAGED_DEPLOYMENT_ID=<stable-installation-id>
export VERITY_UPDATER_TOKEN_HOST_PATH=/etc/verity/updater-token
sudo --preserve-env=VERITY_SERVER_IMAGE,VERITY_MANAGED_DEPLOYMENT_ID,VERITY_UPDATER_TOKEN_HOST_PATH,COMPOSE_PROJECT_NAME \
  ./deploy/bin/verity-compose managed-up
```

`managed-up` first runs the idempotent bootstrap, which accepts only the official
digest-pinned image and seals the complete Server deployment authority. It changes
container ownership only after that succeeds: Compose then owns the Gateway,
Updater, PostgreSQL, and support services, while the Updater alone owns the
managed Server container. If input validation or bootstrap fails, the existing
legacy Server remains running. Keep all three exported values stable for later
host-side Gateway/Updater upgrades; changing the deployment ID is rejected.
The migration command is intentionally privileged so it can validate and bind-mount
the root-owned control token without making that token readable by the invoking user.

After the first app-initiated update, the active Server container has an immutable
generation-qualified name such as `verity-managed-server-g4`. The managed Gateway
persists that selected backend on its private control volume, so restarting the
Compose-owned Gateway does not route back to the bootstrap container. During an
update the Gateway enters maintenance while the old Server stops and the new
generation acquires the database fence and becomes ready. The previous container is
kept stopped through the observation window for rollback, then removed. Existing
project Runners continue independently.

The promoted Server comes up **unlocked**. The outgoing Server seals the master key
to an ephemeral public key that only the incoming one holds, so an update you asked
for once does not end at a password prompt. A cold start is the exception — a host
reboot, or a promotion whose handoff had no one left to ask because the process
holding the key was already gone — and then the store is sealed and needs one unlock
in the app. That is the single manual cost of a restart, and it is not a sign that
the update failed.

Custom images and custom orchestrators are intentionally not adopted and continue
to report Server self-update as unsupported.

### After an update: companion handoff

A self-update first replaces the Server, then uses the same journal to replace
the installed companions. The old Updater moves both Gateways first and starts a
one-shot helper from the exact sealed target digest. The helper copies the seed
to a digest-addressed sibling directory, validates its stamp and complete
required file set, then atomically advances `.current`. Existing sandboxes retain
their prior complete read-only mount; sandboxes created afterwards resolve the
new complete tree. Only after that succeeds does the helper replace the Updater;
the successor reconciles the managed Control Plane Runner and marks the operation
complete. An interrupted or invalid copy never changes `.current`, and the same
journal phase retries deterministically.

`verity-install` remains the topology recovery path. Seed recovery for an
interrupted managed update belongs to the Updater: it resumes the persisted
`reconciling-companions` journal and reruns the target-digest helper. Re-running
the installer is safe and derives the digest from the active managed Server, but
a normal app-initiated update does not require it:

```sh
sudo deploy/bin/verity-install
```

It reads the digest off the running managed Server, reuses the persisted identity,
token and project name, and repairs the bootstrap topology. If it finds two Server
containers it stops and tells you to wait because a cutover is mid-flight.

On a host installed before this script existed there is no state file, so it adopts
the Compose project off the containers that are running. If none of them carries a
Compose project label — a stack brought up by hand, say — it refuses rather than
defaulting to `verity`, because guessing wrong stands a second Postgres, Gateway and
Updater up beside the running ones. Pass `--project <name>` in that case; it is
persisted and reused from then on, so it is checked against the shape Compose
accepts — lowercase letters, digits, dashes and underscores, starting with a letter
or a digit — before anything is written down.

The rest of this section is what it does, for a host where you would rather drive it
by hand. First read the digest back off the running container. The generation suffix
changes with every update, so derive it rather than typing it:

```sh
server="$(docker ps --filter name=verity-managed-server --format '{{.Names}}')"
export VERITY_SERVER_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$server")"
export VERITY_UPDATER_TOKEN_HOST_PATH=/etc/verity/updater-token
printf 'container: %s\nimage:     %s\n' "$server" "$VERITY_SERVER_IMAGE"
```

Check both printed lines before going on — that is what the second block is
separate for. `container:` must name exactly one `verity-managed-server-g<N>`,
and `image:` must be a `@sha256:` digest. Two container names mean an update is
mid-flight; `docker inspect` then fails and leaves the image empty, so wait for
the cutover to finish and run the block again. An empty or non-digest image must
never reach the migration.

Then re-run the migration, with the deployment identity it was installed under:

```sh
export VERITY_MANAGED_DEPLOYMENT_ID=<the same stable-installation-id as before>
sudo --preserve-env=VERITY_SERVER_IMAGE,VERITY_MANAGED_DEPLOYMENT_ID,VERITY_UPDATER_TOKEN_HOST_PATH,COMPOSE_PROJECT_NAME \
  ./deploy/bin/verity-compose managed-up
```

Re-running it is safe by construction: on a deployment that is already sealed the
bootstrap returns the existing authority instead of re-sealing, so it cannot pull
the Server back to the older digest, while Compose recreates the Gateway and the
Updater. The Compose seed service is initial-bootstrap-only once managed identity
exists, so it cannot race the Updater or move `.current` backwards. Persist the
new value wherever you keep the others. In a normal managed update no manual seed
repair is required: `completed` guarantees that the selected seed and companions
converged on the target release.

### When an update fails

A failed update is built to end where it started, without host intervention. Every
step is journalled before it runs, so an Updater that dies resumes rather than
stalls, and a candidate that never becomes ready, a database that disappears
mid-cutover, or a route switch that cannot complete all end in a rollback onto the
previous container, the previous route and the previous control-plane generation.
The app reports the operation as `rolled-back` or `failed`, and the deployment keeps
serving throughout except for the maintenance window.

When it does not resolve itself, check in this order:

```sh
# The previous generation is kept stopped through the observation window; a
# rollback returns to it rather than rebuilding.
docker ps -a --filter name=verity-managed-server

# The Updater names the phase it stopped in.
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.managed.yml \
  --profile managed logs --tail=200 verity-updater

# A rollback parked mid-flight is finished by the Updater's own crash recovery on
# its next start, so restarting that one container is the first thing to try.
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.managed.yml \
  --profile managed restart verity-updater
```

The one thing a rollback cannot do without is PostgreSQL: the returning Server
reclaims the control-plane generation from the database, so an update that fails
while the database is away parks until the database is back and then completes.
Restoring the database is the whole of that recovery — there is no separate repair
step, and no state to unwind by hand.

### When the Updater is crash-looping

The Updater refuses to adopt a Server that is not the one the sealed spec
describes, and on a difference it cannot tolerate it exits. Its restart policy
brings it back, it reaches the same verdict, and it exits again. The symptom is a
`verity-updater` container restarting every few seconds with the same line in its
logs — most often one of these two:

```text
managed Server container conflicts with the sealed deployment spec
managed Server environment source is missing: <NAME>
```

A **value** that has merely changed is no longer fatal: a running Server is kept
on the environment it was created with, and `GET /v1/reconcile` on the Updater's
control socket reports the sealed names that disagree. What still stops the
Updater is a **structural** difference — another image, mounts, user, groups,
network, capabilities, host ceilings, or a variable in the container that neither
the spec nor the image accounts for — and an unresolvable environment source with
no running Server to fall back on.

There is a repair, and it is deliberately blunt. The one operation that rebuilds
the Server from the current environment is the cutover, and a crash-looping
Updater is exactly what makes the cutover unreachable; removing the container
hands the Updater the create path instead, which builds the Server from the
sealed spec as it does on a first install.

Remove **the container the Gateway is routing to**, and only that one. Several
`verity-managed-server*` containers can exist at once — a retained previous
generation, a candidate from an abandoned attempt — and removing an inactive one
changes nothing while leaving the crash loop in place. Listing by name does not
tell you which is which; the Gateway does:

```sh
# 1. The backend the Gateway has selected. This is the authoritative answer.
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.managed.yml \
  --profile managed exec verity-managed-gateway cat /run/verity-gateway/backend.json
# => {"host":"verity-managed-server-g4","publicPort":8082,"internalPort":8083}
#
# No such file means no update has ever completed and the backend is still the
# bootstrap container, verity-managed-server.

# 2. Cross-check what exists, so the name from step 1 is one of them.
docker ps -a --filter name=verity-managed-server

# 3. Remove exactly the host from step 1. Named volumes are NOT touched:
#    verity-data, where all durable state lives, survives untouched.
docker rm -f verity-managed-server-g4

# 4. Restart the Updater. Finding no container on that name, it creates one from
#    the sealed spec and the current environment, and starts it.
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.managed.yml \
  --profile managed restart verity-updater
```

State the cost plainly before running it: this is **one hard control-plane
restart with no drain**. Every in-flight agent session is lost, and any request in
progress fails. That is the right trade for a host that is otherwise bricked — the
control plane is already not serving updates and cannot repair itself — and the
wrong one for anything less. If the Updater is running, do not use this.

If the Updater still exits after the container is gone, the refusal is not about
the container: read its log again. An authority that cannot be read, a deployment
ID that does not match the seal, or two containers on one name are separate
faults, and each says so by name.

### The control-plane generation

Exactly one Server is the control plane, and PostgreSQL records which. Compose
sets `VERITY_CONTROL_PLANE_HOLDER_ID` for you; the managed Server inherits it,
because it replaces the Compose-owned container in the same slot. The value names
that slot, so keep it stable. A dedicated PostgreSQL session lock — not the name
— proves that exactly one Server process is active.

A second Server connected to the same database refuses to start, and says so:

```text
verity: refusing to start — another Server holds the PostgreSQL control-plane process lock
```

That is the fence working: two Servers writing to one database is the failure it
exists to prevent. Find and stop the other Server. The lock belongs to one live
PostgreSQL connection rather than to a table row, so PostgreSQL releases it
automatically if the Server is killed or disconnected. The replacement then
forward-fences any stale active generation before it starts schedulers or opens
listeners; no timeout or force switch is involved.

## Docker socket security note

The default install mounts the **host Docker socket** into the runner
(`/var/run/docker.sock`). This is the simplest self-hosted pattern (Portainer,
Watchtower, …), but stated honestly: a container with the host socket is
effectively **host-root-equivalent**. It is acceptable for a single-operator,
self-hosted control-plane where the operator owns the trust.

The container itself runs as a **non-root user** (`node`, uid 1000); socket
access is granted via `group_add`. Use `./deploy/bin/verity-compose` so Verity
detects the actual group owner of `/var/run/docker.sock` on this host and exports
`VERITY_DOCKER_SOCKET_GID` before Compose creates the container. If you start
Compose yourself, set `VERITY_DOCKER_SOCKET_GID="$(stat -c %g /var/run/docker.sock)"`
or your platform's equivalent.

The relay Unix sockets use supplementary GID `65532` by default. A custom relay
image with a different runtime GID must set `VERITY_PROJECT_RELAY_GID` to that
numeric value; Compose grants the same group to the Verity service.

The default ACP-only Claude deployment enables the Runner supervisor. The
Server also needs `CAP_CHOWN` and the supplementary runtime group configured by
`VERITY_RUNNER_RUNTIME_GID` (default `1101`). `verity-install` and
`verity-compose` layer the required overlay automatically. Direct Compose users must
include it explicitly:

```
docker compose -f docker-compose.yml -f docker-compose.runner-supervisor.yml up -d
```

Bare Docker or custom orchestrator deployments must grant the same `CAP_CHOWN`
and supplementary GID to the Server but must not grant the group to project-agent
users.

## Hardening an internet-reachable host

The reference deployment is designed for a trusted network segment. Everything
below is what changes when the host is reachable from the public internet.

**The API port (8082) is the defensible surface.** Transport is TLS terminated
in-process with a certificate the app pins, every route not on the explicit
pre-auth list requires a per-device bearer token, and `/secret/unlock` and
`/secret/init` are throttled. A direct server also refuses to boot without
pairing material, so the first-run window in which no master password exists
cannot be claimed by an unauthenticated caller. Exposing 8082 is survivable —
but fewer reachable ports is still fewer, so prefer a VPN (WireGuard,
Tailscale) or a host firewall that admits only your devices' addresses when
your setup allows it.

**The Dev Server ranges must not be public.** Host ports `3000–3099` and
`8000–8099` publish project Dev Servers as raw, unauthenticated HTTP — no
bearer, no TLS. Anything an agent starts there is reachable by whoever can
reach the port, and agents act on repository content you may not fully trust.
On an internet-facing host, keep both ranges firewalled to your own clients or
VPN; do not follow the remote-preview note in
[Ports & environment reference](#ports--environment-reference) with a
public-internet allow rule.

**Do not expose anything else.** PostgreSQL and the Claude/Codex egress
gateways (9443/9444) are intentionally unpublished; nothing outside the Compose
network should ever reach them.

**First-run onboarding still belongs on a trusted network.** The boot-time
pairing requirement stops takeover, but the QR pairing payload itself (TLS pin,
bootstrap code) is a secret — scan it where nobody can shoulder-surf a
screenshot of your terminal.

**The Docker socket is not yet isolated.** Do not enable the historical generic
`docker-socket-proxy` example as a security boundary: Verity needs container
creation and exec, so coarse endpoint filtering still permits host-impacting
requests, and its HTTP transport is incompatible with Brokered Secret Jobs.
[ADR 0017](../docs/adr/0017-docker-policy-gateway.md) specifies the
resource-aware Unix-socket Policy Gateway and the end-to-end gates required
before the reference deployment can switch to it. Until then, treat a Server
compromise as a host compromise and keep API exposure correspondingly narrow.

## Claude egress credential boundary

The reference Compose starts Verity's project-scoped Claude egress path in two
phases. The mTLS gateway is reachable only as `https://verity:9443` on the internal
`verity-net` network; port 9443 is never published to the host. Each newly
provisioned or recreated project sandbox receives its own client certificate and
an idempotent loopback connector on port 47821.

An image release containing Phase 1D can additionally start the independently
supervised Agent Gateway process. Its canonical runtime, Compose service key, and
DNS identity are `verity-agent-gateway`. Export the digest-pinned image, then use
the repository wrapper. The unseal key is optional: set it only to adopt a key
already held in the deployment's secret manager, otherwise the Server generates
and persists its own on first start.

```sh
export VERITY_SERVER_IMAGE=<phase-1d-image@sha256:digest>
export VERITY_AGENT_GATEWAY_UNSEAL_KEY=<existing-secret-manager-value>   # optional
./deploy/bin/verity-compose down --remove-orphans
./deploy/bin/verity-compose up -d
```

A first-time installation needs no unseal key: the Server generates one on first
start and persists it on the data volume, so it stays stable across restarts. A
deployment that does export the variable — because an earlier release required it,
or because the key is held in a secret manager — must keep loading that same value
on every upgrade: the preserved gateway-state volume may contain recovery state
encrypted with it.

The `down --remove-orphans` step is required when upgrading from a release whose
Compose service key was `verity-gateway`. It prevents the retired container and
the renamed service from running concurrently against the same control-socket and
state volumes. This cutover briefly stops the stack, but preserves its named
volumes because it deliberately omits `--volumes`. Do not replace these two
commands with a single `up -d` for that upgrade.

The explicit digest-pinned image override is required and must reference a build
containing `agent-gateway-main.js`.
It receives the current TLS and peer-binding snapshot plus a short-lived access
token over the private `verity-agent-gateway-control` Unix-socket volume. The
gateway encrypts its recovery spill with the unseal key, which is never placed in
the gateway environment or persisted there. Every project Sandbox receives
`https://verity-agent-gateway:9443` and routes
Claude through its connector — there is no per-project allowlist, no global switch,
and no un-routed fallback. The gateway leaf covers the in-process listener name
and the Agent Gateway name, so one certificate serves both listeners. The Compose
service key, the container name and the DNS identity are all
`verity-agent-gateway`.

After unlocking Verity, verify connector forwarding, stable-name TLS, exact
provisioning, and non-member denial from the Docker host. Supplying a second,
not-yet-recreated container exercises the full isolation gate; the one-container
form remains available for initial diagnosis:

```sh
deploy/bin/verity-claude-egress-smoke <container> <other-container>
```

Claude project turns receive only the loopback connector URL and a non-secret
placeholder. The real rotating OAuth token remains in the Verity server and is
added only after the request has authenticated to the internal gateway.
Control-plane sessions (`projectId = null`) remain on the trusted server-side token
path.

A Sandbox provisioned before the gateway does not carry the target label. The
Server verifies that exact label before routing a turn and **fails the turn closed**
rather than falling back to injecting the real OAuth token, so such a Sandbox must
be recreated. There is no rollback switch: rolling back means deploying a previous
release.

The smoke check intentionally stops before resolving the OAuth token or contacting
Anthropic, so it does not consume provider traffic. Confirm the final upstream leg
with one normal Claude project turn after the cutover. CI additionally runs
hermetic Phase 1E/2B runtime gates. They keep a real mTLS provider stream open
while the Server-side control synchronizer is replaced, revoke the project while
that stream drains exactly once, and reject new connections immediately. The
rolling-cutover gate also proves that the provision-time target controls the
legacy/stable routing decision and that the stable route receives only the
placeholder credential, forbidden inference paths and non-member peers never
resolve the OAuth token, and the gateway runtime can restart on the stable port
and recover the token from its encrypted spill using only the control-channel
unseal key. These hermetic tests exercise the same runtime boundaries but do
**not** recreate a project Sandbox.

### Fleet preflight

Run the read-only, fail-closed preflight from the Docker host:

```sh
node deploy/bin/verity-agent-gateway-cutover-check.mjs
```

It requires exactly one running Verity control plane and standalone gateway, the
stable `verity-agent-gateway` DNS alias published on a network the **control
plane** reaches, and one running, generation-matched relay per Sandbox.

Reachability is asserted in both directions, because the relay is the only path
to Claude. The control plane must reach the gateway; a Sandbox must **not** — it
is single-homed on its own project network, and its relay talks to the control
plane over a Unix socket on the shared data volume. A Sandbox that shares a
network with the gateway has escaped its project network and fails the check.

Each Sandbox is therefore stamped with its own relay, not with the gateway
origin. The preflight compares the stamp against that project's relay container
and rejects anything else, including the legacy `verity` origin. Missing labels,
duplicates, stopped containers, unknown project components, or an incomplete
control-plane configuration also make it exit non-zero. An empty project fleet is
allowed but emits a warning because no project route was observed.

For a non-default Compose project or stable-origin port:

```sh
COMPOSE_PROJECT_NAME=<name> \
VERITY_AGENT_GATEWAY_URL=https://verity-agent-gateway:9443 \
  node deploy/bin/verity-agent-gateway-cutover-check.mjs
```

The origin must keep the `verity-agent-gateway` hostname; the preflight rejects
an override to a different DNS name.

Only after it prints `READY`, run `verity-claude-egress-smoke`, restart the
gateway service, run the smoke again, and complete one normal Claude project turn
across a Server replacement. That final account-backed turn remains the
installation-specific gate.

**Docker boundary status:** the generic socket-proxy sketch is not a supported
hardening boundary. See
[ADR 0017](../docs/adr/0017-docker-policy-gateway.md) for the resource-aware
gateway design and the tests required before it can replace the raw socket.

## Project-relay readiness check

Per-project isolation and a generation-matched relay are mandatory: Verity has
no shared-network or direct-control-plane fallback, and no separate Compose
overlay to enable. Official Server images bundle the digest-pinned relay image
published by the same release, so the reference Compose stack needs no separate
relay image setting. Custom Server images or non-standard topologies may override
it with `VERITY_PROJECT_RELAY_IMAGE`; the Server refuses to start when neither a
bundled image nor an override is present. Custom deployments outside the
reference Compose stack must also provide `VERITY_DATA_VOLUME`, naming the volume
mounted at `VERITY_ROOT`; the relay-owned Unix sockets cannot use a host-bind
fallback.

Run the read-only host check against a deployed host:

```sh
node deploy/bin/verity-project-relay-cutover-check.mjs
```

If it reports a busy sandbox, let that turn finish and allow the reconciler to
recreate it before re-running.

An installation with no project sandboxes has nothing to verify. Allow an empty
fleet explicitly:

```sh
node deploy/bin/verity-project-relay-cutover-check.mjs --allow-empty
```

The reference Compose project name is `deploy`. If the host was installed with
`docker compose -p <name>`, run the check with the same identity:

```sh
COMPOSE_PROJECT_NAME=<name> node deploy/bin/verity-project-relay-cutover-check.mjs
```

`READY` means every labelled sandbox is single-homed on its own project network,
has exactly one generation-matched relay, each project network contains only that
pair, and exactly one `verity` service in that Compose project is attached to no
project network. Any legacy, mismatched, orphaned, or foreign attachment fails
closed.

## Resource guardrails

The reference Compose file sets conservative memory, CPU, and PID defaults for
the Verity control-plane services and for spawned project sandboxes. These limits
are intentionally sized for a modest single-host install, so one runaway
dependency or build cannot consume the whole machine by default. Tune them in
`.env` when the host has more headroom or a specific project needs it:

```dotenv
VERITY_SERVER_MEMORY=2g
VERITY_POSTGRES_MEMORY=1g
VERITY_SANDBOX_MEMORY=6g
VERITY_SANDBOX_SWAP=0
VERITY_SANDBOX_CPUS=4
VERITY_SANDBOX_CPU_SHARES=512
```

`VERITY_PROJECT_MAX_CONCURRENT_TURNS` (default `2`) caps how many turns execute
at once inside one project Sandbox. Every session of a project shares that one
container and its memory limit, and under gVisor there is no in-Sandbox OOM killer:
when the combined workload outgrows the limit, the host kills the gVisor Sentry and
every session in the Sandbox dies together. A turn over the cap shows a waiting
notice and starts as soon as a slot frees up; Stop cancels it while it waits.
A turn waiting on a permission card keeps its slot, because its agent is still
loaded in the Sandbox. Turns that survive a Server restart still count toward the
cap. Raise the cap together with `VERITY_SANDBOX_MEMORY`, or set `0` to disable it.

Active project Sandboxes sleep after 30 minutes without a running turn, Agent
Loop, dev server, or public preview. New turns and Agent Loops wake them
automatically. This is a product lifecycle rule rather than a deployment setting.

Sleep decides how many sandboxes are resident at all; the limits below govern the
ones that are awake. The two are complementary, and neither replaces the other —
a host whose projects are all mid-turn has nothing to put to sleep.

The memory, CPU, and PID values above are **per-container** ceilings, and nothing
bounds their sum. A host running more projects than it has cores is therefore
oversubscribed by design: six sandboxes at `VERITY_SANDBOX_CPUS=2` want twelve
cores on an eight-core box, and each one is inside its own limit the whole time.
Ceilings alone do not say who yields when they collide — Docker assigns no CPU
weight by default, so the control-plane Server, the relays, and an agent running
a repository-wide lint all sit at the same cgroup v2 `cpu.weight` of 100 and the
box reads as unresponsive while no single container is misbehaving.

`VERITY_SANDBOX_CPU_SHARES` supplies that ordering: it weights project sandboxes
below the control plane and the relays, which keep the default. It is not a
second ceiling and does not slow a build, a test run, or a lint — CPU weight is
work-conserving, so a sandbox with idle neighbours still runs out to its full
`VERITY_SANDBOX_CPUS` quota, and the weight only decides the split while the CPU
is genuinely contended. Read the number as the cgroup v2 weight it becomes rather
than as a fraction of Docker's nominal 1024: runc maps 512 to 20 against that
default of 100. Set it to `0` to opt out and return to one flat weight for
everything.

Choose the value from that conversion rather than by feel. Useful settings sit
between `2` and roughly `2000`; at about `2600` a sandbox draws level with the
control plane, and above that it outranks it — which is the opposite of the
point, and something no amount of range-checking can distinguish from a
deliberate choice. Verity clamps what it sends to Docker's legal `2`–`262144`,
because the ends of that range are not merely useless but unusable: the weight
they convert to would be outside what the kernel accepts, and the container
would fail to start rather than start mis-weighted. Inside the range you get
what you asked for, so the inversion above is yours to avoid.

The weight is applied when a sandbox container is **created**, and a changed
weight is not itself drift: the reconciler compares the memory, swap, CPU and PID
ceilings, so a sandbox that already exists keeps whatever weight it was created
with until something else recreates it. Expect a host to converge as its projects
are next provisioned, repaired, or updated rather than at a fixed point after the
upgrade. To pull a specific project forward, recreate its sandbox.

On the **managed topology** there is a second-order effect worth knowing before
you reach for the override. The Server's environment is resolved from the source
list sealed into the deployment spec at bootstrap, so a host bootstrapped before
this variable existed has no source for it: setting `VERITY_SANDBOX_CPU_SHARES`
in `.env` there is silently ignored and the Server uses the built-in default —
the same 512, so the protection is in place either way, but a deliberate override
will not take. Hosts bootstrapped from this release onward seal the name and
honour it.

Memory has no equivalent weight, and deliberately so: `VERITY_SANDBOX_MEMORY` is a
hard cgroup ceiling, so an over-large workload is stopped inside its own container
rather than being allowed to page the host. Oversubscribing memory across many
concurrent sandboxes still costs reclaim pressure. If a host runs enough projects
at once to feel it, lower `VERITY_SANDBOX_MEMORY` or run fewer projects. Sleep
already keeps idle projects from counting toward this; what is left is the
projects genuinely working at once.

Under gVisor, the default project runtime, the ceiling is hit harder than it
looks. The whole Sandbox is one gVisor Sentry process, and its guest memory is a
shared-memory file charged to the container. gVisor has no OOM killer of its
own, so there is no runaway process inside the guest for the kernel to pick:
it kills the Sentry, and every session of the project goes down together.
Keeping a margin below the limit does not help, because nothing inside the guest
ever uses that margin. That is why the default is 6 GiB rather than 4 GiB, and
why `VERITY_PROJECT_MAX_CONCURRENT_TURNS` limits how many turns share one
Sandbox.

The 6 GiB default assumes a host with room for it. Unlike the CPU ceiling it is
not capped to the host, so on a small machine (8 GiB or less) set
`VERITY_SANDBOX_MEMORY` to what one sandbox can actually get next to the Server
and Postgres.

`VERITY_SANDBOX_SWAP` lets a sandbox use that much swap on top of
`VERITY_SANDBOX_MEMORY`. It defaults to `0` (no swap). Unset, Docker would allow
swap equal to the memory ceiling, so Verity always sets it explicitly. Swap is a
trade-off, not free headroom:

- It only does anything if the **host** has swap configured. Check `swapon --show`.
- Host swap is shared by every container on the machine. A host with 4 GiB of
  swap and five sandboxes at `VERITY_SANDBOX_SWAP=2g` has promised 10 GiB of it.
- A workload that swaps gets much slower. What swap buys a gVisor Sandbox is a
  slow build instead of every session in the project dying at once. Use it when
  that trade is right for the host, and size it so the sum stays near the host's
  swap.

On the managed topology this variable has the same catch as
`VERITY_SANDBOX_CPU_SHARES` above. A host bootstrapped before it existed has
no sealed source for it, so setting it in `.env` there has no effect and swap
stays off.

The CPU ceiling is capped at the host's CPU count, because Docker refuses to
create a container that asks for more. On a 2-core host the default of 4 therefore
gives each sandbox both cores.

Memory, swap, and CPU ceilings are applied when a sandbox container is
**created**. An existing sandbox keeps the limits it was created with until it
is next provisioned, repaired, or updated to a new image. To apply new limits to
a specific project now, recreate its sandbox.

One exception, on the managed topology only: the Server container is created by
the Updater from the sealed deployment spec, not by Compose, so `mem_limit` and
friends on the `verity` service no longer reach it. It carries the same ceilings
(4 GiB with swap disabled, 4 CPUs, 512 PIDs) from that spec instead, and
`VERITY_SERVER_MEMORY` and its siblings do not change them. Everything else in
this section, including the sandbox limits, is unaffected.

## How sandboxes get project data (named volume, no host paths)

Verity clones each project into `VERITY_ROOT/workspaces/<owner>-<repo>` and
materializes short-lived per-project files under `VERITY_ROOT/secrets`. Both live
on the **named `verity-data` volume** mounted at `VERITY_ROOT` in the server. When
it spawns a project's sibling container, the provisioner mounts the relevant
subdir as a **volume subpath** (Docker 25+ `volume-subpath`):

```yaml
# effectively, per sandbox:
--mount type=volume,source=verity-data,volume-subpath=workspaces/<owner>-<repo>,target=/work
```

Because the sibling references the volume by **name**, the daemon resolves it
regardless of where it physically lives — so there is **no host path to keep
consistent, no host directory to create, and no `chown 1000:1000`** (the image
pre-creates `/srv/verity` as uid 1000, and Docker initializes the empty volume
with that owner). This is what a plain host bind-mount could not do for a sibling
container. The control-plane database lives on its own named volume (`verity-db`)
mounted into the internal `postgres` service.

Only deploy-level, non-per-project mounts (the read-only agent-seed toolkit,
`/dev/null`) remain host binds.

## Data & persistence

Everything still comes up with a single `deploy/bin/verity-compose up -d`: the guarded wrapper
always layers the required Runner supervisor topology over the base Compose file. It
runs the control-plane database as an internal `postgres` service alongside the
server, with **no manual password setup and no manual DB steps**. No speech-to-text
service is started. Configure an OpenAI-compatible transcription provider, model,
and optional API key in the app's encrypted Settings. The provider is unavailable
until those settings are complete; deployment environment variables cannot override them.
Postgres is the only runtime database; the server connects via `DATABASE_URL` and
runs its migrations on every startup. The `postgres` service is **not exposed to
the host** (no `ports:`), so it uses **`trust` auth — there is no password** to
store, generate, or configure. The network isolation is the boundary, and
Verity's own secrets are additionally encrypted at rest.

| What                      | Where                                         | Persistence       |
| ------------------------- | --------------------------------------------- | ----------------- |
| Control-plane Postgres DB | `verity-db` named volume → `postgres` service | Survives restarts |
| Project clones            | `verity-data` named volume (`/workspaces`)    | Survives restarts |
| Secrets (App creds, keys) | encrypted in the DB                           | With the DB       |

## Ports & environment reference

Verity reserves host ports `3000–3099` and `8000–8099` for project Dev Servers.
The global database-backed registry assigns the lowest free port across both ranges
and all projects; ports are not caller-selectable. Deleting a Dev Server or project
releases its lease for reuse. Ensure both ranges are available on the Docker host
and allowed by any host firewall when remote preview access is required — but
only for clients you trust: these ports serve project Dev Servers without TLS or
authentication, so on an internet-reachable host keep them restricted to your
VPN or client addresses (see
[Hardening an internet-reachable host](#hardening-an-internet-reachable-host)).

| Variable                              | Default                                                              | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VERITY_API_HOST_PORT`                | `8082`                                                               | Host port published to the mobile app. Container `PORT` remains `8082`.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `PORT`                                | `8082`                                                               | API listen port.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `VERITY_DOCKER_BASE_URL`              | `unix:///var/run/docker.sock`                                        | Docker access (mounted socket, or proxy URL).                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `VERITY_DOCKER_SOCKET_PATH`           | `/var/run/docker.sock`                                               | Host socket path mounted into the runner for the default raw-socket mode.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `VERITY_DOCKER_SOCKET_GID`            | auto-detected by `deploy/bin/verity-compose`; Compose fallback `999` | Group ID that owns the host Docker socket. Host-specific; set explicitly only when not using the wrapper.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `VERITY_GVISOR_SMOKE_IMAGE`           | pinned in `deploy/gvisor/versions.env`                               | Optional alternate smoke image. It must use a full `@sha256:` digest and provide `/bin/sh`; mutable tags are rejected.                                                                                                                                                                                                                                                                                                                                                                                          |
| `VERITY_ROOT`                         | `/srv/verity`                                                        | Data root (the `verity-data` volume mount); Verity derives `workspaces/`, `secrets/`, `sessions/` under it. Baked into the image — no need to set it.                                                                                                                                                                                                                                                                                                                                                           |
| `VERITY_DATA_VOLUME`                  | `verity-data` (compose)                                              | Required name of the data volume shared with sibling sandboxes and project relays. Custom deployments must set it explicitly; there is no host-bind fallback.                                                                                                                                                                                                                                                                                                                                                   |
| `DATABASE_URL`                        | _(required)_                                                         | PostgreSQL connection string for the control-plane DB (pglite is removed from the runtime).                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `VERITY_POSTGRES_PASSWORD`            | _(installer-generated)_                                              | Internal PostgreSQL SCRAM credential. `verity-install` generates 32 random bytes, persists them root-only under `/etc/verity/postgres-password`, and supplies the same value to PostgreSQL and every normal/managed Server generation. Do not set or rotate it by hand.                                                                                                                                                                                                                                         |
| `VERITY_DEFAULT_PROJECT_IMAGE`        | unset / empty                                                        | Base image for repos without `.devcontainer/`, and base input for derived devcontainer images. Empty lazily resolves `verity-sandbox` at this server's own release version (`VERITY_SERVER_VERSION`, baked in at build time) to a pinned digest during provisioning/recreate/update checks, so the server hands out the sandbox image it was published with rather than whatever `:latest` moved to; builds without a release version fall back to the `:latest` channel. Set only for local/private overrides. |
| `VERITY_SANDBOX_TOOLKIT_FEATURE_REF`  | unset / empty                                                        | Devcontainer Feature injected into project devcontainer builds. Empty lazily resolves `verity-sandbox-toolkit` at this server's release version to a pinned digest (`:latest` without a release version). The Feature BAKED into the server image still outranks that resolved ref — it is the trust root the runner-boundary attestation compares each sandbox against — so only an explicit digest set here overrides the bundle, and doing so will fail that attestation unless it matches.                  |
| `VERITY_SERVER_IMAGE`                 | _(required)_                                                         | Digest-pinned Verity Server image containing `agent-gateway-main.js`; the same image is used for the Server and its gateway/init services.                                                                                                                                                                                                                                                                                                                                                                      |
| `VERITY_CLAUDE_EGRESS_GATEWAY_URL`    | `https://verity:9443`                                                | Internal-only multi-tenant mTLS gateway origin projected into project connectors. Never publish this port to the host.                                                                                                                                                                                                                                                                                                                                                                                          |
| `VERITY_CLAUDE_CONNECTOR_PORT`        | `47821`                                                              | Loopback port used by the project-local Claude connector.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `VERITY_AGENT_GATEWAY_CONTROL_SOCKET` | `/run/verity-agent-gateway/control.sock`                             | Server→Gateway synchronization socket; both processes already default to this path. The reference Compose pins the gateway side to that literal, so exporting this alone moves only the Server and breaks synchronization — change it only in a deployment that sets both sides. The private Unix socket lives on a dedicated volume that is never projected into Sandboxes.                                                                                                                                    |
| `VERITY_AGENT_GATEWAY_UNSEAL_KEY`     | _(generated)_                                                        | Encrypts the gateway-local spill for standalone-gateway credential projection. The Server generates a 32-byte hex key on first start and persists it on the data volume; set this only to adopt a key an existing deployment already provisions. It is held by the Server and delivered over the private control socket.                                                                                                                                                                                        |
| `VERITY_AGENT_GATEWAY_URL`            | `https://verity-agent-gateway:9443`                                  | Stable internal-only standalone Agent Gateway origin. Never publish this port to the host.                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Startup transcript sweep

Every boot sweeps backend transcripts
(the Claude/Codex `.jsonl` conversations) under `VERITY_ROOT/runners` whose
session the database no longer knows. It is not a timer: deleting a session now
removes its own transcripts, so the sweep exists for the backlog left by sessions
deleted before that landed, and as a retry for a purge that failed. The safety
checks below remain mandatory; there is no deployment switch that disables cleanup.

A live session's files are protected three ways over: its backend ids, the
`projects/` directory its worktree owns, and a 24 h grace window on file mtime.
On top of that the sweep refuses to act at all in two cases, each logging the
count it did **not** take:

- **The database names no session while the volume holds transcripts.** Nothing
  is removed, in either backend, at `error` — this is what a server pointed at an
  empty or foreign control-plane database looks like, and no guard can tell it
  apart from a deployment that has genuinely never had a session.
- **The worktree guard cannot be shown to be working.** No Claude file is
  removed. Current sessions use the same sandbox-visible CWD mapper for launch,
  session deletion, and this sweep. For artifacts created under an older path
  convention, the sweep accepts one narrower compatibility proof: a live backend
  session id occurring in exactly one encoded-CWD directory. It protects that
  whole directory, including subagents, without matching a basename. At `error`
  when the same live id occurs in multiple directories, ownership is ambiguous;
  at `warn` when neither a current directory nor a unique legacy mapping matches.

The second refusal has no unsafe automatic remedy, and that is deliberate. A
unique legacy-id mapping or a current live Claude directory proves the guard;
otherwise the backlog stays on the volume. If you have confirmed those
files are dead (`docker run --rm -v verity-data:/data …`, or from the host mount)
you can delete them there; the sweep will not be talked into it, and setting
`dry` or `off` does not clear the condition either. Reach for `dry` or `off` when
you suspect a false orphan; you should not need them otherwise.

### Env-drift sandbox recreates

Verity writes certain environment variables into a project Sandbox as a block —
the Claude and Codex egress legs are one such block, all four variables or none.
Docker bakes a container's environment at create time, so a Sandbox created
before a block grew keeps the old, partial one for as long as it lives, and
whatever the missing half configured is simply unreachable from inside it. That
is what a Codex session answering `502 … provisioned without a Codex gateway` in
an otherwise healthy Sandbox is.

The relay reconciler treats a partial block like any other reason to recreate a
Sandbox: it rebuilds idle ones and logs `recreated a sandbox carrying half an env
block`. Two bounds apply, because unlike a missing network or generation label
this repair has no proof that it fixes what it repairs — the environment a
Sandbox comes back with is decided by the deployment's configuration, not by the
recreate. Each project gets three attempts, after which the server logs
`giving up on an env-drifted sandbox` and stops (that error means the
provisioner is not writing the block this deployment expects — read it as a bug
report, not as a transient). That count lives in the server process, so a restart
gives every project its three attempts back — size the blast radius of a
misdeclared block per restart, not per fleet, and reach for the switch below
rather than for a restart loop. And each reconcile pass recreates at most four
drifted Sandboxes, logging a sample of the ones it turned away in a
`reached the per-tick limit on env-drift recreates` line; the rest follow on
later ticks. That second bound is the reconciler's alone — it limits how much of
the fleet one pass may rebuild at once. The two other paths that can recreate a
drifted Sandbox (a turn finding its Sandbox unusable, and provisioning an
existing project) act on one project at a time in response to a request, so they
need no fleet-wide cap; the three-attempt budget is shared with the reconciler
and bounds them.

Know what that costs a project, because this is the first repair that rebuilds
Sandboxes which are healthy in every other respect, and on the first tick after a
block grows it targets most of the fleet. A recreate keeps everything Verity owns
— the workspace clone and every session worktree live on a host bind mount, not
in the container — and discards everything else in the container's writable
layer: packages installed by hand inside a session, background processes, `/tmp`,
anything a session put outside its worktree. No Sandbox is rebuilt under a turn:
the reconciler skips a busy project entirely and picks it up on a later tick,
and the turn-time path rebuilds only when the requesting turn is the sole one
there — any other session's turn defers it the same way.

A drifted Sandbox is never barred from running turns, whether its budget is spent
or the switch is off. It reaches its broker, signs commits and runs the backends
whose egress leg it does have; only the missing leg 502s. Blocking turns instead
would answer one dead leg with a dead project.

`VERITY_RECREATE_ENV_DRIFTED_SANDBOXES=0` turns the whole behaviour off, leaving
drifted Sandboxes exactly as they are. It accepts `1`/`true`/`on` and
`0`/`false`/`off` like `VERITY_PUSH_ENABLED`, defaults to on, and rejects
anything else at startup. It is an emergency switch for one case: a Verity
version that declares a block wrongly and would therefore rebuild Sandboxes that
were never going to come back whole. Normal migration of pre-relay Sandboxes is
unaffected by it.

One case this repair deliberately does not cover: a Sandbox carrying _none_ of a
block. Only a partial block is evidence of drift — a Sandbox built while a
feature was switched off legitimately has no variables for it, and rebuilding
those would mean recreating every Sandbox on any deployment that runs without
egress projection. So turning egress on for a deployment that already has
Sandboxes repairs nothing and logs nothing; recreate those Sandboxes yourself.

Repos with a `.devcontainer/` directory are built with `@devcontainers/cli` on
the configured Docker daemon. Verity injects the bundled
`verity-sandbox-toolkit` Feature into that build so project-specific
devcontainers still receive the shared agent tooling. Runtime-only
`devcontainer.json` keys that Verity's Docker create path does not yet apply
(`remoteUser`, `containerEnv`, `mounts`, `runArgs`, and related settings) fail
closed instead of being silently ignored.
