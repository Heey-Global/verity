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

## Recover

Never run the installer with `--reinstall`; it deletes all data.

**Recommended: update through the app** to a signed target that contains this
correction. The target's controller retires the stale records itself. No host
change is needed first. Until that target is offered, do not retry older targets:
they fail the same way.

**When network protection must return before that target is available**, retire
the stale records by hand. The controller must be stopped while the file
changes; the edit does the same as the corrected controller.

```sh
(
  set -euo pipefail
  systemctl is-active --quiet verity-egress-host.service && {
    echo 'Controller is running; stop here.'; exit 1; }
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
