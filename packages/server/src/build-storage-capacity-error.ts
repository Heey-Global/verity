export class BuildStorageCapacityError extends Error {}

/** A capacity refusal that reclamation could not lift says what reclamation did,
 *  so the operator sees why a retry alone will not help. Other errors pass through. */
export function afterReclamation(refusal: unknown, outcome: string | void): unknown {
  if (!(refusal instanceof BuildStorageCapacityError) || !outcome) return refusal;
  return new BuildStorageCapacityError(`${refusal.message} ${outcome}`, { cause: refusal });
}

/** Whether a failure, or anything in its cause chain, is a build-storage
 *  capacity refusal: the one failure that released storage can resolve. */
export function isBuildStorageCapacityRefusal(error: unknown): boolean {
  for (let current = error, depth = 0; current !== undefined && depth < 8; depth++) {
    if (current instanceof BuildStorageCapacityError) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}
