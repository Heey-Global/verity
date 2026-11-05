import { readFileSync } from 'node:fs';

/** Fixed root-managed, read-only shared mount. Presence permanently opts this
 * process into inventory fencing; a damaged or removed contract cannot disable it.
 */
export function createProjectEgressInventoryContractReader(
  read: () => string = () => readFileSync('/run/verity-egress-key/inventory-contract.json', 'utf8'),
): () => boolean {
  let required = false;
  return () => {
    let source: string;
    try {
      source = read();
    } catch (error) {
      if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      required = true;
      throw new Error('System inventory contract is unavailable', { cause: error });
    }
    required = true;
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      throw new Error('System inventory contract is invalid');
    }
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'required,version' ||
      (value as { version?: unknown }).version !== 1 ||
      (value as { required?: unknown }).required !== true
    )
      throw new Error('System inventory contract is invalid');
    return true;
  };
}
