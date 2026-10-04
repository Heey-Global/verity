import type { UplinkDiagnostics } from './uplink-control-client.js';

export function previewSharingCapability(
  available: boolean,
  configured: boolean,
  diagnostics?: UplinkDiagnostics,
): 'available' | 'premium-required' | 'unavailable' {
  if (available) return 'available';
  if (
    !configured ||
    diagnostics?.control === 'connected' ||
    ['unknown_key', 'revoked', 'expired'].includes(diagnostics?.reason ?? '')
  )
    return 'premium-required';
  return 'unavailable';
}
