import { isDeepStrictEqual } from 'node:util';
import { isCompatible, type ServerCompat } from './compat.js';
import {
  parseSignedReleaseChannel,
  type ReleaseArchitecture,
  type SignedReleaseChannel,
} from './release-channel.js';

export interface BridgeRecoverySnapshot {
  readonly deploymentId: string;
  readonly image: string;
  readonly architecture: ReleaseArchitecture;
  readonly compatibility: ServerCompat;
}

export interface BridgeRecoveryPlan {
  readonly deploymentId: string;
  readonly previousImage: string;
  readonly bridgeImage: string;
  readonly bridgeVersion: string;
  readonly successorImage: string;
  readonly successorVersion: string;
}

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

/** Explicit recovery considers a signed intermediate release without changing stable-channel state. */
export async function planBridgeRecovery(input: {
  readonly current: BridgeRecoverySnapshot;
  readonly bridge: unknown;
  readonly successor: unknown;
  readonly verify: (release: SignedReleaseChannel) => Promise<boolean>;
  readonly inspectBridge: (image: string) => Promise<{
    readonly architecture: ReleaseArchitecture;
    readonly compatibility: ServerCompat;
  }>;
}): Promise<BridgeRecoveryPlan> {
  const bridge = parseSignedReleaseChannel(input.bridge);
  const successor = parseSignedReleaseChannel(input.successor);
  if (bridge === null || successor === null) throw new Error('Invalid signed release envelope');
  for (const release of [bridge, successor]) {
    if (!(await input.verify(release))) throw new Error('Release signature verification failed');
    if (release.metadata.architecture !== input.current.architecture)
      throw new Error('Release architecture does not match the running Server');
  }
  const from = input.current.compatibility;
  const middle = bridge.metadata.compatibility;
  const to = successor.metadata.compatibility;
  if (
    !newer(middle.serverVersion, from.serverVersion) ||
    !newer(to.serverVersion, middle.serverVersion)
  )
    throw new Error('Recovery requires increasing installed, bridge, and successor versions');
  if (
    middle.schema.current !== from.schema.current ||
    middle.schema.max <= from.schema.max ||
    to.schema.current <= from.schema.current
  )
    throw new Error(
      'Recovery requires a bridge on the current schema with an explicit forward promise',
    );
  for (const [a, b] of [
    [from, middle],
    [middle, to],
  ] as const) {
    const result = isCompatible(a, b);
    if (!result.compatible)
      throw new Error(`Bridge transition is incompatible: ${result.reasons.join('; ')}`);
  }
  if (isCompatible(from, to).compatible)
    throw new Error('The successor is directly compatible; a schema bridge is unnecessary');
  // Pull/probe only after both signatures and both transitions have been checked.
  const actual = await input.inspectBridge(bridge.metadata.serverImage);
  if (
    actual.architecture !== input.current.architecture ||
    !isDeepStrictEqual(actual.compatibility, middle)
  )
    throw new Error('Bridge image does not match its signed compatibility metadata');
  return {
    deploymentId: input.current.deploymentId,
    previousImage: input.current.image,
    bridgeImage: bridge.metadata.serverImage,
    bridgeVersion: middle.serverVersion,
    successorImage: successor.metadata.serverImage,
    successorVersion: to.serverVersion,
  };
}
