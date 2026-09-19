import { isDeepStrictEqual } from 'node:util';
import { isUpgradeCompatible, type ServerCompat } from './compat.js';
import {
  parseSignedReleaseChannel,
  type ReleaseArchitecture,
  type SignedReleaseChannel,
} from './release-channel.js';
import type { BridgeRecoverySnapshot } from './bridge-recovery.js';

function newer(next: string, previous: string): boolean {
  if (![next, previous].every((value) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)))
    return false;
  const a = next.split('.').map(BigInt);
  const b = previous.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return false;
}

export async function planDirectRecovery(input: {
  readonly current: BridgeRecoverySnapshot;
  readonly target: unknown;
  readonly verify: (release: SignedReleaseChannel) => Promise<boolean>;
  readonly inspectTarget: (image: string) => Promise<{
    readonly architecture: ReleaseArchitecture;
    readonly compatibility: ServerCompat;
  }>;
}) {
  const target = parseSignedReleaseChannel(input.target);
  if (target === null) throw new Error('Invalid signed release envelope');
  if (!(await input.verify(target))) throw new Error('Release signature verification failed');
  if (target.metadata.architecture !== input.current.architecture)
    throw new Error('Release architecture does not match the running Server');
  if (
    !newer(target.metadata.compatibility.serverVersion, input.current.compatibility.serverVersion)
  )
    throw new Error('Recovery requires an increasing version');
  const compatibility = isUpgradeCompatible(
    input.current.compatibility,
    target.metadata.compatibility,
  );
  if (!compatibility.compatible)
    throw new Error(`Target upgrade is incompatible: ${compatibility.reasons.join('; ')}`);
  const actual = await input.inspectTarget(target.metadata.serverImage);
  if (
    actual.architecture !== input.current.architecture ||
    !isDeepStrictEqual(actual.compatibility, target.metadata.compatibility)
  )
    throw new Error('Target image does not match its signed compatibility metadata');
  return {
    deploymentId: input.current.deploymentId,
    previousImage: input.current.image,
    targetImage: target.metadata.serverImage,
    targetVersion: target.metadata.version,
  };
}
