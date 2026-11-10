# Protected build cleanup across relay image updates

A protected build anchor can outlive its creating controller. During an update,
its image can differ from the target release's relay image, including when
intermediate releases are skipped. The target controller must retain installed
image authority for cleanup without admitting that image for new builds.

Configuration generation reads the private build attachment projection. After
stopping the old controller, provisioning reconciles its private controller and
allocation checkpoint again, covering partial creation and allocations made
after the initial snapshot. Only images within installed release authority can
be retained. Existing limits on retained images and execution contract changes
still apply. Missing resources require successful exact-ID enumeration; an
inspection failure never proves absence.

The cleanup path continues to require workload termination, immutable object
identities, the fixed container contract and the owned network. Live anchors
also require their original namespace identity. Ordinary admission and renewal
accept only the target image. No new state field or intermediate release is
required for old checkpoints.

## Bounded recovery procedure

This is a procedure for a separately authorized maintenance window. It does not
authorize direct deletion of containers, networks, build records or provisioning
journals.

1. Preserve the failed update journal and controller logs. Read the installed
   relay policy, failed staged policy and anchor's `Config.Image` to establish
   which installed digest the anchor requires. Do not infer authority from image
   labels or from its container name alone.
2. Confirm a released target contains both the provisioning retention changes
   and the cleanup admission changes. Retrying the original affected release
   does not install this fix. Use the supported update/recovery entry point;
   do not edit staged policy or remove transaction state to force a retry.
3. Before retrying, confirm the managed transaction has recovered to a coherent
   installed release and that storage admission passes. If recovery is pending,
   the installed policy is missing, the anchor image is outside installed
   authority, or identities differ, stop and investigate the concrete state.
4. The managed path must stop the old controller, retain the required installed
   image, deny build traffic and prove the complete build workload has ended
   before cleanup. A termination or ownership failure is an abort condition,
   not permission for manual removal.
5. Verify the update operation succeeds, the target controller is ready and the
   interrupted attempt has a terminal receipt. Check cleanup removed only that
   attempt's anchor/network and that a subsequent build uses the target image.
   A later reconciliation may drop the retained image once no protected resource
   needs it; do not manually prune it during recovery.

Implementation verification and a successful production recovery are separate
results. Host recovery remains unverified until the supported update completes.

## Cleanup failures and held storage reservations

Protected build cleanup runs only after the build workload is proven to have
ended. It then denies the attempt's packet authority, releases its fence tables,
removes the anchor container and network, and deletes the attempt's host files.
Each step is retried as a whole until it succeeds.

### Failure evidence

Fence changes are single nft transactions with a one-second budget. A failed
transaction reports its exit code or signal, its duration, whether the budget
expired, and up to four nft error messages with the script line they name.
When that line is a bare table, chain or set operation, the statement is
included. Rule text that nft echoes back is never logged, because it contains
project addresses and admission identifiers. If the budget expired, the kernel
may or may not have committed the change, so treat the outcome as unknown.

The host journal reports lifecycle problems as `verity: protected build
lifecycle` entries. Each entry carries:

- the event: `cleanup_failed`, `cleanup_recovered` or `begin_refused`;
- the project and attempt identifiers, plus the identifier of any attempt that
  blocks the slot;
- the operation that ran (`begin`, `restore`, `revalidate`, `status`, `cancel`
  or `close`);
- the failed step, for example `authority.deny`, `authority.release`,
  `network.remove` or `files.cleanup`;
- the consecutive failure count and the next retry delay.

The supervisor sweep retries a failed cleanup after a delay that doubles from
two seconds up to five minutes. An explicit `begin` retries immediately, and a
host restart clears the delay.

### Behavior across partial failure and restart

- Fence replacements no longer depend on what the host process remembers. The
  transaction declares each table, chain and set before flushing or deleting it,
  so an object that is already gone cannot fail every later denial. If a
  replacement fails, the previous policy stays in force, and the host-wide
  bootstrap fence keeps denying traffic for every build bridge that is not active.
- A failed cleanup does not stop the host from restarting once the record shows
  the workload ended. A record whose termination is not proven still has to be
  contained before the host serves requests.
- After termination is proven, `cancel` and `status` confirm it even while
  resource removal is still being retried.
- A `begin` refused before the host takes on the attempt (`slot_busy`, or a
  failed cleanup of the previous attempt) records a terminal `failed` receipt
  for the refused attempt. Nothing was started for it. Later `status`, `cancel`
  and `begin` calls for that attempt return the receipt, never `unknown_attempt`,
  and the attempt can never start afterwards.
- The Server releases a protected build reservation only on host evidence: a
  terminal record or receipt for the exact attempt, a host reboot, or both of
  the following together:
  - an `unknown_attempt` answer for the attempt;
  - an idle-slot answer, asked after the attempt began, from a host that
    restored its persisted state at startup.

  The single slot is never handed to another attempt while its current attempt
  may still be running. So an idle slot proves that an attempt it no longer
  knows about is not running. Transport errors, other refusals, a busy slot, or
  a host that started without persisted state keep the reservation.

### Recovering an attempt stuck behind a failing cleanup

Symptoms:

- `begin` fails with `cleanup_failed`, and then `cancel` for the same attempt
  answers `unknown_attempt`;
- the host journal repeatedly reports the previous attempt's cleanup failing;
- Server diagnostics keep a `protected-build` reservation because "remote
  build/import termination is not yet confirmed".

This procedure needs a separately authorized maintenance window. Do not delete
the reservation, the Server's remote-operation record, the build anchor, its
network, fence tables or host build state by hand. A held reservation is the
safe failure mode.

1. Collect read-only evidence first. Save the host journal entries for the
   failing cleanup, the Server's storage diagnostics, and lists of nft tables,
   build anchors and build networks. With hosts older than this release, a
   cleanup failure only says `Project fence transaction failed`. A table that is
   missing at that point is consistent with this fault, but it is not proof.
2. Install a release that contains these changes through the supported managed
   update. The fix is in the host egress service, so the update must install the
   new host bundle as well as the Server. Confirm that the active host release
   identity changed and that the host service restarted from it.
3. On startup, the host restores the ended previous record and retries its
   cleanup. Check the journal for a later `cleanup_recovered` entry or the
   absence of new `cleanup_failed` entries. If cleanup still fails, the entry now
   names the step and nft's error; investigate that before going further.
4. Within a few reconciliation cycles the Server asks about the held attempt.
   The host answers `unknown_attempt` and reports an idle slot, so the Server
   logs `Build storage released …: the protected builder confirmed the attempt
   ended` and removes the reservation. If the slot is not idle, or the host
   started without persisted state, the reservation stays until a terminal
   receipt, an idle slot or a host reboot provides evidence.
5. Verify the outcome:
   - Server diagnostics no longer list the reservation;
   - the previous attempt's anchor, network and fence tables are gone;
   - a new protected build completes;
   - its storage admission succeeds without the released estimate.

Publishing these changes does not resolve the stuck attempt by itself. The
attempt counts as recovered only after steps 3 to 5 have been observed on the
affected host.
