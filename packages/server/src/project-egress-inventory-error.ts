/** Fixed internal command diagnostics. Never include endpoint data or raw exceptions. */
const inventoryFailureReasons = [
  'inventory_busy',
  'inventory_lease_expired',
  'inventory_not_configured',
  'inventory_snapshot_required',
  'inventory_dns_failed',
  'inventory_persistence_failed',
  'inventory_replace_failed',
  'inventory_fencing_failed',
] as const;
type InventoryFailureReason = (typeof inventoryFailureReasons)[number];
export class ProjectEgressInventoryError extends Error {
  constructor(
    readonly reason: InventoryFailureReason,
    readonly correlationId?: string,
  ) {
    super(reason);
  }
}
export function inventoryFailureReason(value: unknown): InventoryFailureReason | undefined {
  return inventoryFailureReasons.find((reason) => reason === value);
}
