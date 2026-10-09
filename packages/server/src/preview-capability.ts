import type { UplinkDiagnostics } from './uplink-control-client.js';

export type PreviewSharingCapability =
  'available' | 'premium-required' | 'unavailable' | 'disabled';

export function previewSharingCapability(
  available: boolean,
  configured: boolean,
  diagnostics?: UplinkDiagnostics,
  /** The operator's Online sharing switch. Only meaningful once a key is stored:
   * without one the answer is "premium required", whatever the switch says. */
  enabled = true,
): PreviewSharingCapability {
  if (configured && !enabled) return 'disabled';
  if (available) return 'available';
  if (
    !configured ||
    diagnostics?.control === 'connected' ||
    ['unknown_key', 'revoked', 'expired'].includes(diagnostics?.reason ?? '')
  )
    return 'premium-required';
  return 'unavailable';
}
