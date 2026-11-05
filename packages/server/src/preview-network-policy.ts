import type { ContainerInspect } from './docker.js';

export class PreviewShareConflictError extends Error {}

/** The current connector has no attested ingress route through the project fence. */
export class PreviewNetworkProtectionError extends PreviewShareConflictError {
  constructor() {
    super(
      'Previews are unavailable for network-protected containers: a protected preview ingress route is not configured.',
    );
  }
}

export function assertPreviewNetworkSupported(sandbox: Pick<ContainerInspect, 'networks'>): void {
  if (Object.keys(sandbox.networks ?? {}).some((network) => network.startsWith('verity-egress-')))
    throw new PreviewNetworkProtectionError();
}
