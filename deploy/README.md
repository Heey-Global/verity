# Verity deployment guide

This guide is for whoever runs the Linux host that Verity is installed on. It
covers what the installer sets up, how to configure, secure, and size the
installation, and where its data lives. If you are installing Verity for the
first time, start with the [getting started guide](../docs/getting-started.md)
instead; it covers the whole path to a first session, including the setup in
the app.

The **Verity Server image** is the single container the installer runs on a
Docker host. It is API-only: the compiled server plus the `docker` CLI and
`git` it needs to clone repositories and start project containers. It also
serves the browser app. Everything else, such as the master password, AI
provider logins, GitHub, and projects, is configured from the app. The image is
published by the release workflow with a SemVer tag (`v3.28.0` format), an
immutable `sha-<short>` rollback tag, and the mutable `latest` channel tag; the
`verity-sandbox` image and `verity-sandbox-toolkit` artifact follow the same
policy. The packaging is described in
[ADR 0003](../docs/adr/0003-runner-image-and-deployable-packaging.md).

## Contents

- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [First-run setup](#first-run-setup)
  - [Browser access](#browser-access)
  - [Pair another device](#pair-another-device)
  - [Master password](#master-password)
  - [Upgrade notes](#upgrade-notes)
- [Updates and recovery](#updates-and-recovery)
- [Docker socket security note](#docker-socket-security-note)
- [Hardening an internet-reachable host](#hardening-an-internet-reachable-host)
- [Claude egress credential boundary](#claude-egress-credential-boundary)
- [Project-relay readiness check](#project-relay-readiness-check)
- [Resource guardrails](#resource-guardrails)
- [How sandboxes get project data](#how-sandboxes-get-project-data-named-volume-no-host-paths)
- [Data & persistence](#data--persistence)
- [Ports & environment reference](#ports--environment-reference)

## Prerequisites

For one active project sandbox, plan for **16 GiB of RAM and 4 CPU cores**.
This is a sizing recommendation, not a tested minimum. The default per-sandbox
limits are 6 GiB of RAM and a CPU quota of 4 cores, shared against the host's
available CPU capacity rather than reserved cores. The Server, PostgreSQL,
other services, and the host also need memory. For smaller hosts, lower the
[resource limits](#resource-guardrails); allow additional capacity for multiple
active sandboxes.

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

The public bootstrap temporarily downloads cosign v3.1.3 for the host's
architecture and validates it against an embedded SHA-256 checksum. It pulls
the official release, resolves it to an immutable digest, verifies its signature
against the official GitHub release workflow identity, and copies the release-matched deployment bundle into a fresh root-owned
directory, and runs the guarded installer below. The temporary bundle is removed
afterwards; durable deployment identity remains under `/etc/verity`. It requires
Docker 25+, Compose v2, and root access through either the current account or
`sudo`. The privileged installer deliberately uses the root Docker daemon;
Rootless Docker is not accepted as a source for code that will execute as root.

Cosign is removed on exit and is not installed on the host. A download,
checksum, or signature verification failure stops the bootstrap before image
code executes or deployment files are extracted. Recovery also verifies the
existing Server image before using it as a helper. Unsigned historical images
cannot be recovered through this bootstrap; there is no verification bypass.
Network access to GitHub releases, the registry, and Sigstore trust services is
required. The bootstrap script itself remains the initial trust anchor.

App updates receive the verifier with a normal confirmed Server update. Once
installed, the networked Server checks the target image signature before
submitting an update to the network-isolated Updater. Direct and bridge recovery
commands also check the target signature before executing target-image probes.
When run on the host, recovery commands temporarily download and checksum
cosign if the bundled binary is unavailable; no host package installation is needed.
The existing signed release-channel checks remain in place; the update that
first introduces this verifier still uses the preceding release's update logic.

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

## First-run setup

The installer creates a stable TLS and server identity plus a pairing link
that is valid for 15 minutes, both under `/etc/verity`, and prints the link as
a QR code and as a `verity://pair?` line. The
[getting started guide](../docs/getting-started.md) walks through the setup in
the app step by step. In short:

1. **Pair the first device.** Scan the QR code in the iPhone or iPad app, or
   paste the `verity://pair?` line into the app or into the browser app (see
   below). The client verifies the pinned TLS certificate and the signed server
   identity. When `verity-install` asks for the address, choose one your
   devices can reach, or set `VERITY_PAIRING_HOST` for automation. Automatic
   address detection excludes interfaces named `docker0`, `docker1`, and so
   on, `br-*`, and `veth*` when the host has working `ip` tooling; private LAN
   and Tailscale addresses remain eligible.
2. **Set the master password.** It derives the at-rest encryption key for the
   secrets stored in the database (ADR 0002 D3). Until it is set the store is
   sealed; the server logs `secret store is UNINITIALIZED and SEALED` on boot,
   which is expected.
3. **Connect one AI provider**: a Claude or Codex subscription login, or an
   OpenAI-compatible endpoint for OpenCode. Claude and Codex credentials stay
   on the Server and are brokered to project sandboxes; an OpenCode API key is
   not covered by that boundary.
4. **Add a project.** An empty project needs nothing else. A GitHub repository
   needs the GitHub connection, which can be added at any time under
   Settings → Connections.

To get a new pairing link after the first one expires, run the installer again
and choose "Repair this installation".

### Browser access

The Server image includes the browser build of the app and serves it at
`https://<host>:8082/app/` (the API port, `VERITY_API_HOST_PORT`). The Server
presents its self-signed certificate, so the browser shows a certificate
warning on first use. Unlike the native app, a browser cannot check that
certificate against the pin in the pairing link; a user who accepts the
warning on an untrusted network has no protection against interception for
that visit, so the first browser sign-in belongs on a trusted network or VPN.
Sign-in on the "Connect this browser" page accepts the
installer's `verity://pair?` line or a pairing link created from an already
paired device, then creates or asks for the master password and issues a
private session cookie for that browser. A browser can therefore be the first paired client.
Browsers sign out and create invitations for further browsers under
Settings → Devices.

### Pair another device

After the first device is set up, open **Settings → Devices → Pair another
device**. Verity creates a five-minute, one-use invitation. Scan its QR code on a
phone or tablet, or copy the pairing link and paste it into the iPad app running
on a Mac or into the browser app's "Connect this browser" page. Each device
receives its own bearer token and can be removed independently from the same
screen. The master password is never included in the invitation.

### Master password

The master password is the only way to unlock the secret store — there is no
env-key/headless auto-unlock. On restart the store comes up sealed and is
unlocked from the app; run the first-time onboarding on a trusted network until
the password is set.

### Upgrade notes

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

## Updates and recovery

A paired installation updates from the Verity app; the host-side `--update`
path of the installer is fenced off after pairing. The promoted Server comes up
unlocked, except after a cold start such as a host reboot, which needs one
unlock in the app. An update that cannot complete is designed to roll back to
the previous generation; the app then reports it as `rolled-back` or `failed`,
and the cases that need a hand are described in the guide linked below.

Running the installer again on an existing host is safe. Interactively it
offers to repair the current release without changing data, to update an
installation that has not paired its first device yet, or to replace it
completely. The public bootstrap and a repository checkout run the same
installer:

```sh
curl -fsSL https://verity.build/install.sh | bash   # repair, or print a new pairing link
sudo deploy/bin/verity-install                       # the same, from a checkout
```

To discard an installation **and all of its data**, pass `--reinstall`. The
installer asks for the exact phrase `DELETE VERITY` on the terminal before
removing containers, volumes, the database, projects, sessions, stored
secrets, and the pairing identity, then performs a fresh install:

```sh
curl -fsSL https://verity.build/install.sh | bash -s -- --reinstall
```

Automation can make the same destructive choice explicitly with
`--reinstall --yes`.

Adopting a hand-built deployment for managed updates, what the companion
handoff does, and what to check when an update fails or the Updater is
crash-looping are covered in
[Server updates and recovery](../docs/operations/server-updates-and-recovery.md).

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

**The API port (8082) uses TLS and device authentication.** The mobile app pins
the server certificate, and API routes outside the explicit pre-authentication
list require a per-device bearer token after pairing. `/secret/unlock` and
`/secret/init` are throttled. A direct server refuses to boot without pairing
material. See [SECURITY.md](../SECURITY.md) for the security model and known
limitations.

The reference Compose deployment publishes port 8082 on all host interfaces.
Prefer access limited to your devices through a trusted network or VPN such as
WireGuard or Tailscale. Using a VPN to connect does not itself restrict access
through other host interfaces.

**Docker-published ports can bypass ufw rules.** Docker forwards incoming traffic
to containers before the usual ufw input rules apply. An active ufw firewall
therefore does not establish that port 8082 is blocked. Use network filtering
that covers Docker's published ports and verify access from both an allowed
client and a network that should be denied. See Docker's
[firewall documentation](https://docs.docker.com/engine/network/packet-filtering-firewalls/#docker-and-ufw).

**The local preview range must not be public.** Host ports `8100–8119`
(default `VERITY_LOCAL_PREVIEW_PORT_RANGE`) serve local HTTP and WebSocket previews
without authentication or TLS. Allow this range only from trusted LAN clients or
your VPN. Docker-published ports need filtering that covers Docker forwarding;
ordinary ufw input rules alone do not establish that the range is restricted.
Public previews use the authenticated Uplink edge instead.

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
VERITY_SANDBOX_PIDS_LIMIT=4096
```

Active project Sandboxes sleep after 30 minutes without a running turn,
automation check, dev server, or public preview. New turns and automations wake
them automatically. This is a product lifecycle rule rather than a deployment setting.

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
it kills the Sentry, and every session of the project goes down together. The
guest cannot even be asked to behave: the cgroup limits gVisor exposes inside the
Sandbox are unenforced, and its platform processes are created to die together
with the Sentry, so any OOM kill in the container's cgroup ends the whole
Sandbox. That is why the default is 6 GiB rather than 4 GiB: the ceiling has to
fit every turn the project runs at once, not a single process.

Because nothing in the runtime uses the margin below the limit, the Sandbox
toolkit runs a memory guard (`verity-memory-guard`) that stands in for the
missing guest OOM killer, the way earlyoom or kubelet eviction act before the
kernel does. Started by the root stack pass next to the spawn broker, it polls
the cgroup's usage every 500 ms and, once usage reaches the ceiling minus a
reserve, freezes and then SIGKILLs the agent-owned process tree that holds the
most memory. A tree is ranked by the memory of all its processes, because a
worker pool respawns a single killed worker. Under a Claude or Codex session the guard
narrows from the agent CLI to the command it ran — the tool shell with `npm
test`, the test runner and its workers — and, when several commands run at once,
to the largest of them. The CLI itself goes only when its own memory is most of
its tree and that tree holds at least the reserve, so an ordinary idle CLI is
never killed for cache pressure. For adapters that run commands directly,
what they start is a command like any other. The ACP adapter the broker started is never a candidate; one orphaned to init by a
broker restart counts as a detached tree. A process tree detached under init (a
backgrounded dev server or database) is a candidate of its own. If usage is
still above the threshold once the cooldown after a kill has passed, the guard
assumes the rest is page cache, tmpfs or steady load that another kill would not
cure, logs `suspended`, and kills nothing more until usage drops below the
threshold or grows by another quarter of the reserve (closer to the ceiling, by
half the remaining room), so it never works through the sessions one by one. The
reserve is a fifth of the ceiling, at least 1 GiB and at most half the ceiling,
because the guest cannot see the Sentry's own memory; at the 6 GiB default the
guard acts at about 4.8 GiB. Usage includes the guest page cache and tmpfs,
which live in the same host-charged memory file and therefore count against the
ceiling too. The victim's command ends with exit 137 and no kernel message, the
session that ran it sees that failure, and the other sessions of the project
keep running. Infrastructure is never a candidate: only processes of the agent
identity qualify, never root or the Runner identity, and nothing under 64 MiB.
Every kill is recorded in `/run/verity-runner-broker/memory-guard.log` inside
the Sandbox with the usage, the victim's command and the session worktree it ran
in.

The guard is a mitigation, not an isolation boundary. An allocation burst
between two polls can still reach the host limit, and growth in the Sentry's own
memory is invisible from inside. If a project still loses its Sandbox that way,
`VERITY_SANDBOX_SWAP` below is the next lever: it turns the remaining cases into
a slow build instead of a dead project. Three container environment variables
tune the guard for a project whose devcontainer sets them:
`VERITY_MEMORY_GUARD=0` disables it, `VERITY_MEMORY_GUARD_RESERVE_BYTES`
replaces the reserve with an explicit byte count below the ceiling, and
`VERITY_MEMORY_GUARD_INTERVAL_MS` changes the poll interval (100 to 60000 ms;
anything else keeps 500). A Sandbox without a readable finite memory limit runs
no guard, and neither does a runc Sandbox: there the kernel already kills one
process at the ceiling and the container survives, so a guard would only kill
builds a reserve early. The guard recognizes gVisor by the kernel version it
reports.

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

`VERITY_SANDBOX_PIDS_LIMIT` defaults to 4096 and remains configurable. With
runsc (gVisor), the host PID cgroup counts Sentry and platform threads, rather
than only guest processes. A small limit can therefore be exhausted by routine
builds even when few guest processes are visible. [gVisor issue #2490](https://github.com/google/gvisor/issues/2490)
describes Sentry termination with `failed to create new OS thread` / `newosproc`
when the host PID limit is exhausted. Keep this limit generous; the sandbox
memory ceiling remains unchanged. Runtime diagnostics report current PID usage
and flag usage at or above 80% of a finite limit. A sample taken after restart
does not establish PID usage before the crash; host runtime logs are needed to
confirm the cause.

Managed deployments treat an env-source `VERITY_SANDBOX_PIDS_LIMIT=512` as a
legacy bootstrap default and pass an empty value to new Servers, which use the
current default of 4096. The Updater logs when it ignores this pin. This also
applies to older sealed deployments without editing the host `.env`. Other
values and file-backed sources remain configurable. To deliberately retain 512,
set `VERITY_SANDBOX_PIDS_LIMIT_ALLOW_LEGACY=1` in the host `.env` and recreate the
Updater through installation Repair so it receives that input; the opt-in works
even with an older sealed deployment. Unmanaged Servers retain their configured
value.

Applying the migration requires an Updater version containing it and a guarded
Server replacement. Existing project sandboxes must also be recreated after
active work finishes; restarting an existing container does not change its PID
limit. A running Server with the old pin remains available; reconciliation
reports environment drift until replacement.

Memory, swap, CPU, and PID ceilings are applied when a sandbox container is
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

### Dependencies: a per-project `node_modules` volume

A project with an npm `package-lock.json` at its root gets one more named volume,
`verity-node-modules-<project>`, mounted over `/work/node_modules`. It is a whole
volume rather than a `verity-data` subpath because of gVisor: the provisioner
passes runsc a mount hint (`dev.gvisor.spec.mount.node-modules.*`,
`share=container`) that gives the Sandbox exclusive access to that mount, so the
Sentry may trust its own file cache instead of revalidating every lookup against
the host. runsc pairs a hint with a mount by comparing its source path, and only a
whole named volume has a source path that is known in advance (its daemon
`Mountpoint`). Dependency-heavy commands are several times faster this way; the
exclusivity is sound because nothing outside the Sandbox writes that volume.

- **Only with the Runner supervisor.** Its root start pass hands the fresh,
  root-owned volume to the agent. Without it the Sandbox keeps `node_modules` on
  `verity-data` as before.
- **Only for npm lockfiles.** The volume starts empty and shadows the clone's
  `node_modules`, and only an npm lockfile can be installed without anyone
  acting. yarn and pnpm projects, and npm projects without a lockfile, keep
  `node_modules` on `verity-data`.
- **One-time install.** On every Sandbox start, `verity-node-modules-install`
  runs in the background as the agent. If the volume holds no finished npm
  install, it runs `npm ci` once, which runs the project's own install scripts
  inside the Sandbox like any install would. The outcome is in
  `/tmp/verity-node-modules/status` and the npm output in
  `/tmp/verity-node-modules/install.log` inside the Sandbox. Anything the script
  cannot do itself (no `npm` or `flock` in the image) is reported there as
  `manual:`. With a devcontainer `postCreateCommand`, the provisioner first
  lets that install finish (`verity-node-modules-install --wait`), then runs the
  command under the same lock (a `flock` on `/work/node_modules` itself). One
  that installs too, such as `npm ci`, therefore never races the install into
  `ENOTEMPTY`, and one that does not still finds dependencies in place.
- **A devcontainer's own `node_modules` volume is left to it.** When
  `devcontainer.json` mounts something at `node_modules` itself, Verity creates
  no volume and sets `VERITY_NODE_MODULES_INSTALL=0` in the Sandbox, so
  `verity-node-modules-install` reports `skipped:` and the project's
  `postCreateCommand` is the only install into that volume.
- **Requires Engine API 1.43+** (Docker 24+) for `HostConfig.Annotations`, which
  carries the hint. The default unversioned `unix:///var/run/docker.sock` uses the
  daemon's newest API. A `VERITY_DOCKER_BASE_URL` pinned to an older API version drops the
  annotation: the volume still works, just without the speed-up.
- **Existing projects** switch over the next time their Sandbox is recreated
  (an image update, a repair, or a manual recreate), and the one-time install
  then fills the new volume. The
  `node_modules` the clone had on `verity-data` stays on disk, shadowed by the
  mount. It is no longer used, and you can delete it to reclaim the space.
- **Deleting a project with purge** removes the volume. The disk GC never
  touches named volumes, so this is the only way it is reclaimed.

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

Verity reserves one contiguous host range for local previews, default `8100–8119`.
Set `VERITY_LOCAL_PREVIEW_PORT_RANGE=8100-8119` in the deployment environment to
change it (1–200 nonprivileged ports, excluding the API ports). The same range is
published on the legacy Server or managed Gateway and used internally by the
Server. Changing it requires restarting the ingress container; creating or
revoking a share never recreates the project sandbox. Ports are assigned only
while shares are active. A full range produces an explicit capacity error.

Managed self-updates reconcile the Gateway's local preview listener range and
publish missing host ports even when the Gateway image already matches the target.
The migration uses the running managed Server's range and reconciles existing
preview bindings, including legacy loopback bindings. Preview ports default to all
host interfaces for LAN and VPN access. Set `VERITY_LOCAL_PREVIEW_BIND_ADDRESS`
to an explicit host IP to restrict access (bracket IPv6 addresses, for example `[::1]`); Compose and managed updates use the same
setting. Local previews are unauthenticated: public interfaces require appropriate
host firewall restrictions. API port bindings remain unchanged.
A failed replacement restarts the previous Gateway.
This requires an Updater with companion reconciliation; deployments predating
that mechanism still require the documented managed-bootstrap migration.
Self-update changes the runtime container configuration, not the host's installed
Compose files. Before manually recreating the Gateway with Compose, update those
files to the current release so the recreation retains the preview configuration.

Local previews are open HTTP, including REST APIs and WebSockets. Restrict the
range to trusted clients or VPN addresses; it must never be exposed directly to
the public internet. A network firewall may also need updating when the range
changes. Docker's optional `userland-proxy: false` setting can reduce the process
overhead of published ports; its actual memory cost depends on the Docker
configuration and should be measured on the host.

Start an HTTP/WebSocket service yourself or ask the agent to start it, then open
the detected listener in the session Preview sheet. Local access uses the Verity
ingress range. Services listen inside the sandbox; the connector forwards requests
from the allocated preview port to the service.

| Variable                              | Default                                                              | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VERITY_API_HOST_PORT`                | `8082`                                                               | Host port published to the mobile app. Container `PORT` remains `8082`.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `VERITY_LOCAL_PREVIEW_PORT_RANGE`     | `8100-8119`                                                          | Identical host/container range for open local HTTP and WebSocket previews. Restrict to trusted LAN/VPN clients; changing it requires restarting the ingress container.                                                                                                                                                                                                                                                                                                                                          |
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

Remote Control uses the existing paired TLS ingress automatically when a Uplink
subscription is configured and grants the `remote-control` feature. In direct
TLS mode, the connector dials the Server's loopback listener on `PORT`; in
managed mode, it dials the private TLS Gateway at `verity:8082`. Without a
subscription key, Core does not connect to Uplink. The paired app still uses
the Server's HTTPS URL and verifies its stored certificate pin.

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
