import { lstatSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What the host has provisioned for build admission. The host builder
 * installation creates the lock and the lease directory together before any
 * snapshotter maintenance can run, so a directory with neither marks a host
 * whose builder predates managed admission, not one in maintenance.
 */
export type BuilderAdmissionState =
  | { state: 'provisioned' }
  | { state: 'migration-pending' }
  | { state: 'not-provisioned' }
  | { state: 'incomplete'; missing: string[] };

const NOT_PROVISIONED_MESSAGE =
  "This host's devcontainer builder predates managed build admission, so builds run without host storage admission. Re-run the verified Verity installer once on the host to provision it.";

export function builderAdmissionMessage(admission: BuilderAdmissionState): string {
  switch (admission.state) {
    case 'provisioned':
      return 'Managed build admission is provisioned.';
    case 'migration-pending':
      return 'Builder migration recovery is pending; new builds wait until the host verifies the previous worker.';
    case 'not-provisioned':
      return NOT_PROVISIONED_MESSAGE;
    case 'incomplete':
      return `Managed build admission is incomplete (missing ${admission.missing.join(', ')}); re-run the verified Verity installer once on the host.`;
  }
}

export function readBuilderAdmissionState(directory: string): BuilderAdmissionState {
  const present = (name: string) => {
    try {
      lstatSync(join(directory, name));
      return true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
      // Unreadable is not absent: never relax admission on an error we cannot classify.
      throw cause;
    }
  };
  if (present('migration-pending')) return { state: 'migration-pending' };
  const markers = ['build-admission.lock', 'leases'];
  const missing = markers.filter((name) => !present(name));
  if (missing.length === 0) return { state: 'provisioned' };
  if (missing.length === markers.length) return { state: 'not-provisioned' };
  return { state: 'incomplete', missing };
}
