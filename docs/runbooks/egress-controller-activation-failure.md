# Network protection controller stops after a failed activation

Use this runbook when an update fails with `phase observe, code host_failed,
reason activation_failed, step activation` and the host's
`verity-egress-host.service` is no longer running afterwards. For failures in
`phase staging`, see
[Network protection provisioning fails during staging](egress-provisioning-staging-failure.md).

## What happened

Activation installs the target's network protection release, then starts its
controller. Before the controller serves, it checks that every container recorded
for an active project network still matches its binding. Releases before this
correction treat a recorded container that Docker no longer has (HTTP 404) as a
binding mismatch. They stop and refuse to serve. The log then shows
`Restored container binding mismatch; containment attempted` with the message
`Host Docker inspection refused or API 1.47 unsupported`. That message covered
every non-success Docker answer, including 404, and does not mean the API version
is unsupported.

The failed activation rolls back the files to the previous release. Releases
before this correction leave that controller stopped. The previous release runs
the same check. A manual `systemctl start verity-egress-host.service` therefore
fails the same way while the stale record remains.

With the correction:

- When a binding fails its check, the controller asks Docker about all of its
  containers and its network. If Docker reports any of them as absent (404), the
  binding is retired: it stays denied and its remaining containers are stopped.
  Any other Docker answer still prevents serving.
- Docker errors name the status: not found (404), refused (403), rejected request
  with possibly unsupported API (400), or the other status code.
- A failed activation restarts a previously running controller after rollback
  and checks that it is active. If that restart fails, the update reports
  `reason recovery_failed, step recovery`. A controller that was already stopped
  before the update stays stopped after a failed one.

The activation code runs from the target release, so the correction takes effect
through a normal update from an installed release that lacks it.

## Check the host

Run as root. These commands only read state.

```sh
systemctl is-active verity-egress-host.service
journalctl -u verity-egress-host.service --no-pager -n 50 |
  grep -E 'binding mismatch|inspection refused|HTTP [0-9]{3}'
```

Count active registry records whose containers Docker no longer lists:

```sh
jq -r '.records[] | select(.retired == false) | .containers[]?' \
  /var/lib/verity-egress/registry.json | sort -u |
  while IFS= read -r id; do
    found=$(docker container ls --all --quiet --no-trunc --filter "id=$id") || {
      echo 'Docker query failed'; break; }
    if [ -z "$found" ]; then echo missing; fi
  done | sort | uniq -c
```

Only `missing` lines identify stale records. A `Docker query failed` line proves
nothing; fix Docker access first.

## The previous controller fails its preflight

The update renews the host runtime before network protection activates. The
gVisor `runsc` binaries and the Docker registrations `runsc`, `runsc-project` and
`runsc-relay` move to the target's gVisor release. A failed activation rolls back
only the network protection release, units and configuration, not the host
runtime. The previous controller's preflight binds to the gVisor release it was
assessed with, so it then refuses to start. The host stays fail-closed: project
egress is denied.

Releases before this correction report that as `runtime_preflight_failed` and,
when started by hand, restart every second. With the correction:

- The activation rollback returns `runsc-project` and `runsc-relay` to the gVisor
  release the restored release was assessed with, and rewrites
  `/etc/verity-egress/relay-runtime.json` to match. It first verifies that
  release's `runsc` against the assessed checksum and tree digest. It then takes the
  host runtime service's lock, validates the configuration with `dockerd
  --validate`, reloads Docker and waits until Docker reports both registrations.
  It refuses while a host runtime transaction is pending, and it restores the
  original `daemon.json` when the reload does not converge. The plain `runsc` entry
  stays with the host runtime service.
- It then clears the unit's failed state, starts the previous controller and
  checks that it is active. Any failure stops the unit and reports
  `reason recovery_failed, step recovery`.
- The preflight reports `native_identity_changed` when the project runtime
  registration or runtime files differ, and `relay_runtime_mismatch` when the relay
  registration differs.

Confirm this cause with read-only commands:

```sh
grep RUNSC_RELEASE /opt/verity-egress/native-runtime-pins.env
jq -c '.profile.runtime.path' /etc/verity-egress/assessment.json
jq -c '.runtime.path' /etc/verity-egress/relay-runtime.json
jq -c '.runtimes | with_entries(.value |= .path)' /etc/docker/daemon.json
ls -d /opt/verity/runsc/release-*
```

The cause is confirmed when the first two name an older gVisor release than the
Docker registrations and `relay-runtime.json`.

### Restore the previous controller by hand

Releases without this correction need the same steps by hand. Run them as root
and keep the backups. The host runtime service changes these registrations only
when an update or the installer asks it to, so the restore holds until the next
update renews the host runtime again, which is expected.

1. Read the assessed runtime from
   `jq -c '.profile.runtime' /etc/verity-egress/assessment.json`. Confirm that
   `sha512sum` of that `path` matches its `sha512`. If the file is missing or
   differs, stop here and update through the app instead.
2. Confirm that `/var/lib/verity/host-runtime-private/daemon-install/pending` does
   not exist and that no host runtime reconciliation is running
   (`systemctl list-units 'verity-host-runtime*'`). Then back up
   `/etc/docker/daemon.json` and `/etc/verity-egress/relay-runtime.json` with
   `cp -p`.
3. In `daemon.json`, set only the `path` of `runsc-project` and `runsc-relay` to
   that runtime path, keeping their `runtimeArgs`. Check the result with
   `dockerd --validate --config-file /etc/docker/daemon.json`, then run
   `systemctl reload docker` and confirm the new paths in
   `docker info --format '{{json .Runtimes}}'`.
4. Set `.runtime` in `relay-runtime.json` to `.profile.runtime` from
   `assessment.json`, keeping mode `0600`.
5. If a stale registry record blocks the start, retire it as described under
   Recover.
6. Run `systemctl reset-failed verity-egress-host.service`, then
   `systemctl start verity-egress-host.service`, and confirm `active` with
   `systemctl is-active verity-egress-host.service`.

Do not retry server updates through the app until a release with these
corrections is available. Older targets repeat the failure.

## Recover

Never run the installer with `--reinstall`; it deletes all data.

**Recommended: update through the app** to a signed target that contains this
correction. The target's controller retires the stale records itself. No host
change is needed first. Until that target is offered, do not retry older targets:
they fail the same way.

**When network protection must return before that target is available** and
the previous controller passes its preflight, retire the stale records by hand.
The controller must be stopped while the file changes; the edit does the same as
the corrected controller.

```sh
(
  set -euo pipefail
  state=$(systemctl show --property=ActiveState --value verity-egress-host.service)
  case $state in inactive | failed) ;; *)
    echo "Controller is $state; run systemctl stop verity-egress-host.service first."; exit 1 ;; esac
  /usr/bin/python3 /usr/local/libexec/verity/project-egress-managed.py verify-runtime || {
    echo 'Controller preflight fails; see the preflight section.'; exit 1; }
  cd /var/lib/verity-egress
  cp -p registry.json "registry.json.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  missing=$(jq -r '.records[] | select(.retired == false) | .containers[]?' registry.json |
    sort -u | while IFS= read -r id; do
      found=$(docker container ls --all --quiet --no-trunc --filter "id=$id") || exit 1
      if [ -z "$found" ]; then printf '%s\n' "$id"; fi
    done | jq -R . | jq -s .)
  jq -c --argjson missing "$missing" '.records |= map(
      if .retired == false and ([.containers[]?] | any(. as $c | $missing | index($c)))
      then .retired = true | .cleanupContainers = true else . end)' \
    registry.json > .registry-manual
  chown --reference=registry.json .registry-manual
  chmod --reference=registry.json .registry-manual
  mv .registry-manual registry.json
  sync -f registry.json
  systemctl start verity-egress-host.service
  systemctl is-active verity-egress-host.service
)
```

The parentheses keep `exit` and `set -e` from closing your shell. If any Docker
query fails, the block stops before the file changes. It handles removed
containers only; the corrected controller also handles a removed network. If the
controller still fails to start, restore the backup copy and keep the journal
output for diagnosis. The controller removes networks of retired records and
stops their remaining containers during its periodic cleanup. Affected projects
receive a fresh network the next time their sandbox starts.

## Verify

- `systemctl is-active verity-egress-host.service` prints `active`.
- The app shows network protection as available.
- After a successful update, the app shows the new server version and
  `/var/lib/verity-egress/install-transaction.json` does not exist.

A failed operation keeps its `recovery-required` host preparation record. That
record belongs to the failed update only: the next update started in the app
creates a new operation and does not read it, so no host command is needed to
clear it. After a manual restore, `/etc/verity-egress-server/status.json` can
still read `controller_failed`. The server uses it only as a fallback diagnostic,
and the next successful provisioning rewrites it.
