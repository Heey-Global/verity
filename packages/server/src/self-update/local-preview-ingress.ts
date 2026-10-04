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
  const missing = ports.filter((port) => !gateway.portBindings?.[`${port}/tcp`]?.length);
  if (configuredRange === range && missing.length === 0) return undefined;
  // TLS API ingress does not authorize exposing unauthenticated preview ports.
  const address =
    bindAddress ??
    gateway.env
      ?.find((entry) => entry.startsWith('VERITY_LOCAL_PREVIEW_BIND_ADDRESS='))
      ?.slice('VERITY_LOCAL_PREVIEW_BIND_ADDRESS='.length) ??
    '127.0.0.1';
  if (!isIP(address)) throw new Error('local preview binding must be an IP address');
  const portBindings: ContainerReplacementConfig['portBindings'] = {};
  for (const port of missing) {
    portBindings[`${port}/tcp`] = [{ HostIp: address, HostPort: String(port) }];
  }
  return { env: { VERITY_LOCAL_PREVIEW_PORT_RANGE: range }, portBindings };
}
