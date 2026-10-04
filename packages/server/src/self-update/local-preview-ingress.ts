import { isIP } from 'node:net';
import type { ContainerInspect, ContainerReplacementConfig } from '../docker.js';
import { localPreviewPorts } from '../local-preview-ports.js';

/** Image replacement alone preserves legacy gateways with no host preview ingress. */
export function localPreviewIngressMigration(
  gateway: ContainerInspect,
  serverRange?: string,
  bindAddress?: string,
): ContainerReplacementConfig | undefined {
  const configuredRange = gateway.env
    ?.find((entry) => entry.startsWith('VERITY_LOCAL_PREVIEW_PORT_RANGE='))
    ?.slice('VERITY_LOCAL_PREVIEW_PORT_RANGE='.length);
  const range = serverRange ?? configuredRange ?? '8100-8119';
  const ports = localPreviewPorts(range);
  const address =
    bindAddress ??
    gateway.env
      ?.find((entry) => entry.startsWith('VERITY_LOCAL_PREVIEW_BIND_ADDRESS='))
      ?.slice('VERITY_LOCAL_PREVIEW_BIND_ADDRESS='.length) ??
    '0.0.0.0';
  if (!isIP(address)) throw new Error('local preview binding must be an IP address');
  const portBindings: ContainerReplacementConfig['portBindings'] = {};
  for (const port of ports) {
    const existing = gateway.portBindings?.[`${port}/tcp`];
    if (existing?.length && existing.every((binding) => (binding.HostIp || '0.0.0.0') === address))
      continue;
    portBindings[`${port}/tcp`] = [{ HostIp: address, HostPort: String(port) }];
  }
  if (configuredRange === range && Object.keys(portBindings).length === 0) return undefined;
  return {
    env: { VERITY_LOCAL_PREVIEW_PORT_RANGE: range, VERITY_LOCAL_PREVIEW_BIND_ADDRESS: address },
    portBindings,
  };
}
