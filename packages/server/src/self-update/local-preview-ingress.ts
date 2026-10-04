import type { ContainerInspect, ContainerReplacementConfig } from '../docker.js';
import { localPreviewPorts } from '../local-preview-ports.js';

/** Image replacement alone preserves legacy gateways with no host preview ingress. */
export function localPreviewIngressMigration(
  gateway: ContainerInspect,
  serverRange?: string,
): ContainerReplacementConfig | undefined {
  const configuredRange = gateway.env
    ?.find((entry) => entry.startsWith('VERITY_LOCAL_PREVIEW_PORT_RANGE='))
    ?.slice('VERITY_LOCAL_PREVIEW_PORT_RANGE='.length);
  const range = serverRange ?? configuredRange ?? '8100-8119';
  const ports = localPreviewPorts(range);
  const missing = ports.filter((port) => !gateway.portBindings?.[`${port}/tcp`]?.length);
  if (configuredRange === range && missing.length === 0) return undefined;
  // Inherit the ingress interface restriction instead of widening a VPN-only deployment.
  const ingress = gateway.portBindings?.['8082/tcp'];
  if (missing.length > 0 && !ingress?.length)
    throw new Error('local preview migration requires published managed Gateway API bindings');
  const portBindings: ContainerReplacementConfig['portBindings'] = {};
  for (const port of missing) {
    portBindings[`${port}/tcp`] = ingress!.map(({ HostIp }) => ({
      HostIp,
      HostPort: String(port),
    }));
  }
  return { env: { VERITY_LOCAL_PREVIEW_PORT_RANGE: range }, portBindings };
}
