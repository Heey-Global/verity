# Server updates and recovery

This guide covers what happens after the first installation: adopting an
installation for app-initiated Server updates, what a managed update does, and
how to recover when an update fails or the Updater refuses to run. It is
written for whoever operates the Linux host. First-time installation is in the
[getting started guide](../getting-started.md); the rest of the host
configuration is in the [deployment guide](../../deploy/README.md).

In normal operation none of this is needed: a paired installation updates from
the Verity app, and a failed update rolls back on its own. Reach for the
sections below when the app reports an update as `failed` or `rolled-back` and
it does not resolve itself, or when the host was set up by hand.

## Contents

- [Migrate to managed Server updates](#migrate-to-managed-server-updates)
- [After an update: companion handoff](#after-an-update-companion-handoff)
- [When an update fails](#when-an-update-fails)
- [When the Updater is crash-looping](#when-the-updater-is-crash-looping)
- [The control-plane generation](#the-control-plane-generation)

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
use the [verified schema-bridge recovery procedure](../runbooks/server-0.15-schema-bridge.md).
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
