/** Public diagnostics are a fixed vocabulary; never expose host errors or configuration. */
export const projectEgressHealthReasons = [
  'ready',
  'not_configured',
  'provisioning_pending',
  'provisioning_in_progress',
  'runtime_unsupported',
  'assessment_authorization_invalid',
  'docker_host_unsupported',
  'native_package_unavailable',
  'relay_runtime_missing',

  'provisioning_failed',
  'controller_failed',
  'key_unreadable',
  'invalid_configuration',
  'socket_missing',
  'permission_denied',
  'service_unreachable',
  'authentication_failed',
  'timeout',
  'protocol_mismatch',
  'host_not_ready',
  'mandatory_inventory_incomplete',
  'packet_enforcement_unavailable',
] as const;
export type ProjectEgressHealthReason = (typeof projectEgressHealthReasons)[number];
export interface ProjectEgressHealth {
  available: boolean;
  reason: ProjectEgressHealthReason;
}
export class ProjectEgressHealthError extends Error {
  constructor(readonly reason: ProjectEgressHealthReason) {
    super('Host control operation failed; execution outcome may be unknown');
  }
}
export function projectEgressFailure(error: unknown): ProjectEgressHealth {
  return {
    available: false,
    reason: error instanceof ProjectEgressHealthError ? error.reason : 'host_not_ready',
  };
}

/** Root-owned provisioning diagnostics can explain an outage, never establish readiness.
 * /etc/verity-egress-server/status.json deliberately records an unavailable reboot
 * fallback. /run is ephemeral; neither file overrides authenticated live health.
 */
export function projectEgressInstallationFailure(input: unknown): ProjectEgressHealth | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const status = input as Record<string, unknown>;
  if (status.version !== 1 || status.state !== 'unavailable') return undefined;
  if (
    status.reason !== 'provisioning_in_progress' &&
    status.reason !== 'mandatory_inventory_incomplete' &&
    status.reason !== 'runtime_unsupported' &&
    status.reason !== 'assessment_authorization_invalid' &&
    status.reason !== 'docker_host_unsupported' &&
    status.reason !== 'native_package_unavailable' &&
    status.reason !== 'relay_runtime_missing' &&
    status.reason !== 'provisioning_failed' &&
    status.reason !== 'controller_failed'
  )
    return undefined;
  return { available: false, reason: status.reason };
}

/** Host egress availability for Settings, cached for ten seconds so a hung host service
 * cannot stall every settings read. Enabling always bypasses this display cache. */
export function projectEgressAvailability(
  lifecycle: () => { health(): Promise<ProjectEgressHealth> } | undefined,
  installationStatus?: () => unknown,
  provisioningPending: () => boolean = () => false,
): (fresh?: boolean) => Promise<ProjectEgressHealth> {
  let cached: { value: ProjectEgressHealth; at: number } | undefined;
  return async (fresh = false) => {
    if (!fresh && cached && Date.now() - cached.at < 10_000) return cached.value;
    let value = (await lifecycle()?.health()) ?? {
      available: false,
      reason: 'not_configured' as const,
    };
    if (
      !value.available &&
      ['not_configured', 'socket_missing', 'service_unreachable'].includes(value.reason)
    ) {
      try {
        value = projectEgressInstallationFailure(installationStatus?.()) ?? value;
      } catch {
        // Missing, corrupt or unreadable diagnostics never hide the live probe result.
      }
    }
    if (value.reason === 'not_configured' && provisioningPending())
      value = { available: false, reason: 'provisioning_pending' };
    cached = { value, at: Date.now() };
    return value;
  };
}
