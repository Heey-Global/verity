# Avoid Docker subnet conflicts

If Docker assigns a bridge subnet that overlaps a LAN or VPN, the host may route
traffic into that bridge instead of to the intended destination. For example,
`192.168.48.0/20` includes a LAN at `192.168.50.0/24`.

Verity's project bridges and reference Compose networks do not specify fixed
subnets. They use Docker's allocation defaults. Configure `default-address-pools`
on the host to control future allocations; no Verity setting is required. This
does not renumber existing networks or override explicitly configured subnets.

## Choose a pool

Inventory routes while the relevant VPNs are connected, and inspect every Docker
network, including networks with stopped containers:

```sh
ip -4 address show
ip -4 route show table all
docker network ls
docker network inspect NETWORK_NAME
```

Repeat the inspection for each network. Also account for remote LANs, disconnected
VPNs, cloud networks, and other container platforms that are not currently visible
in the routing table. Choose a private range that does not overlap any of these;
no private range is universally safe. A default route alone does not rule out a
private range.

For example, **only if `172.28.0.0/16` is unused in your environment**, a pool with
`base` set to `172.28.0.0/16` and `size` set to `24` supplies 256 separate `/24`
networks. Allow enough networks for projects, relays, other applications, and
future growth. Do not choose the entire `172.16.0.0/12` merely because it is
private: a VPN may already use part of it.

## Configure Docker

For a conventional rootful Linux Docker Engine installation, edit
`/etc/docker/daemon.json`. Confirm whether the service uses a custom
`--config-file` or address-pool flags first:

```sh
sudo systemctl cat docker
```

Back up an existing configuration before editing. Merge the following property
into its top-level JSON object, adjusting the range to your inventory:

```json
{
  "default-address-pools": [{ "base": "172.28.0.0/16", "size": 24 }]
}
```

This is an example property, **not a replacement for the existing file**. Preserve
all other settings, especially the `runsc` and `runsc-project` runtime definitions,
runtime arguments, authorization plugins, storage, logging, and DNS settings.
If `default-address-pools` already exists, deliberately reconcile its entries
rather than adding a duplicate key. The same daemon option cannot also be set
through service flags.

Validate before restarting:

```sh
sudo dockerd --validate --config-file=/etc/docker/daemon.json
```

Validation checks the configuration, not whether the selected range conflicts
with your networks. Check service flags separately for duplicate options.
Schedule a maintenance window: restarting Docker can interrupt all applications
on the host, including Verity. Finish active turns first and arrange host access
that does not depend on the affected containers. Then restart and inspect:

```sh
sudo systemctl restart docker
sudo systemctl status docker --no-pager
docker info
```

Confirm both gVisor runtimes remain registered. If Docker fails to start, inspect
`sudo journalctl -u docker -n 100 --no-pager`, restore the backed-up configuration,
and restart Docker. Restoring the configuration does not renumber networks
already created from the new pool.

## Migrate an existing overlapping network

An existing user-defined bridge keeps its subnet after the daemon restart. Plan
its migration separately; the configuration change alone will not fix its route.

1. Record the network's inspection output, attached containers, owner, labels,
   options, aliases, and any static IP dependencies. Inspect the mounts of every
   affected container and verify backups of application data. Keep inspection
   output private because container configuration can include secrets.
2. Identify the owning deployment's recreation procedure and stop its active
   workloads and automatic reconcilers for the maintenance window. Stopping a
   container alone does not necessarily release its network attachment.
3. Use that deployment's supported procedure to remove or disconnect the affected
   endpoints. Remove only the target network after all endpoints are detached:
   `docker network rm NETWORK_NAME`. Do not force unrelated containers off it.
4. Let its owner recreate the network with its original name, labels, driver,
   options, and isolation properties, without an obsolete explicit subnet. Recreate
   or reconnect its containers through that same owner, preserving mounts and DNS
   aliases. Static addresses and subnet-based firewall rules require adjustment.
5. Inspect the new subnet, host routes, and mounts. Verify LAN/VPN access, Verity
   connectivity, project startup, and existing project files before resuming work.

For a Compose deployment you administer, a maintenance-window `docker compose
down` followed by `docker compose up -d`, using the **same project name, files,
environment, and profiles**, can recreate Compose-owned networks. First ensure
it is the correct stack and all persistent data uses known named volumes or bind
mounts: anonymous volumes are not automatically reattached by `up`. External
networks and containers outside that Compose project require separate handling.
Never add `-v`, delete data volumes, or use a blanket network/volume prune.

**Verity-managed project networks need their owner involved.** They carry
generation labels and sandbox/relay isolation requirements. Do not manually
reconnect a project to the control-plane network, invent network labels, or
replace managed container specifications. Project container recreation alone
does not guarantee that an existing network is replaced. Coordinate the network
replacement with Verity's provisioning lifecycle; if your deployment provides no
supported network migration procedure, leave its network intact and seek a
deployment-specific migration procedure before removing anything. This runbook
does not introduce an automatic managed-network migration.

The built-in `bridge` network is a separate case: do not delete it as if it were
a user-defined bridge. Review Docker's `bip` and `fixed-cidr` settings if that is
the conflicting network.

## References

- [Docker daemon configuration](https://docs.docker.com/engine/daemon/)
- [Docker daemon address pools and validation](https://docs.docker.com/reference/cli/dockerd/)
- [Docker network removal prerequisites](https://docs.docker.com/reference/cli/docker/network/rm/)
- [Compose down and volume behavior](https://docs.docker.com/reference/cli/docker/compose/down/)

## Address pool exhaustion

Docker may refuse network creation with `all predefined address pools have been
fully subnetted` or `could not find an available, non-overlapping IPv4 address
pool`. This is exhaustion of available **subnets**, even when each project uses
only two container addresses. Large default `/16` and `/20` allocations can
consume the default pools with a few dozen projects. A bridge marked `linkdown`
or containers marked `exited` do not establish that a network is abandoned.

Use the route and network inventory above to choose a non-overlapping pool and
smaller per-network allocations, such as `/24`. The operator owns this choice;
Verity does not choose a private range or rewrite daemon configuration. Cleanup
cannot replace capacity planning: active projects and retained sleeping Sandboxes
continue to reserve their networks. Configuring a new pool leaves existing
networks and their routes unchanged.

Verity removes proven-owned empty legacy project networks during deprovisioning
and retries abandoned-network cleanup through its periodic lifecycle reconciler.
It preserves active and transitional projects, retained sleeping Sandboxes,
foreign networks, incomplete inventory, and networks still referenced by running
or stopped containers. Cleanup uses immutable network IDs and never forces an
endpoint disconnect. Failures are reported and retried on subsequent passes.

For protected generations the trusted host service records allocation intent
before creating the network. Its periodic cleanup recovers interrupted creation
and removes retired networks only after checking the exact binding and all
container references. An allocation must establish the verified Sandbox/relay
transport within five minutes; an expired allocation rejects starts and is
retired on the next cleanup pass. This also reclaims completed allocations whose
response was lost before the Server could use them. Successfully connected
Sandboxes have no allocation deadline, including while sleeping. Abandoned
allocations may reclaim stopped containers with matching project, generation and
network ownership even when a Server died before registering their IDs.
Docker housekeeping runs outside the global host admission queue; inventory
fallback reads have explicit count and elapsed-time budgets. Incomplete or slow
inventory defers deletion rather than extending the queue indefinitely. Explicit retirement also permits removal of its recorded,
verified, stopped containers; retirement during host restoration alone does not
permit container deletion. Permanent denial and retirement records remain after
network deletion, so stale generations cannot regain authority. Old unregistered
networks without a durable creation intent are left intact: a name prefix alone
is not sufficient evidence to delete them.

Deploy the matching host service before using the updated protected-network
allocation flow. An older service rejects the new allocation operation; the
Server must not fall back to creating an unregistered protected network. Host
state now includes allocation intents and cleanup progress; preserve that state
and use a compatible host service when recovering or rolling back a deployment.

Verify after rollout that repeated project provisioning/removal and generation
replacement stop increasing the abandoned-network count, that sleeping projects
still wake, and that a new project starts successfully. Logs containing `project
network cleanup deferred` identify resources that require another pass or an
ownership/inventory investigation. Do not delete retired-generation records or
firewall rules to make cleanup appear successful.
