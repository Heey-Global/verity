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
