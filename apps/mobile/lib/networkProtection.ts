import type { VeritySettings } from '@verity/mobile';

export function networkProtectionStatus(settings: VeritySettings | null): string {
  if (settings === null) return 'Loading…';
  if (settings.projectEgressEnabled === undefined || settings.projectEgressAvailable === undefined)
    return 'Server update required';
  if (!settings.projectEgressAvailable) return 'Host service unavailable';
  return settings.projectEgressEnabled ? 'On' : 'Off';
}

/** Unknown codes and older servers retain a useful generic message. */
export function networkProtectionUnavailableReason(settings: VeritySettings | null): string {
  const reasons: Record<string, string> = {
    runtime_unsupported:
      'This host does not have a validated runtime profile for network protection.',
    provisioning_failed: 'Automatic host service provisioning failed.',
    controller_failed: 'The host service could not start or pass its readiness checks.',
    provisioning_in_progress: 'Automatic host service provisioning is in progress.',
    provisioning_pending:
      'Automatic host service provisioning is pending. Install the next compatible server update.',
    not_configured: 'The host service has not been configured by this installation.',
    key_unreadable: 'The server cannot read the host service control key.',
    invalid_configuration: 'The host service configuration is invalid.',
    socket_missing: 'The host service control socket is missing. The service may be stopped.',
    permission_denied: 'The server does not have permission to reach the host service.',
    service_unreachable: 'The host service is not responding.',
    authentication_failed: 'The server and host service control keys do not match.',
    timeout: 'The host service did not respond before the readiness deadline.',
    protocol_mismatch: 'The server and host service versions are incompatible.',
    mandatory_inventory_incomplete:
      'The host has not yet verified all configured broker destinations.',
    host_not_ready: 'The host service is not ready to protect project containers.',
    packet_enforcement_unavailable: 'The host service is running without packet enforcement.',
  };
  return (
    reasons[settings?.projectEgressStatus?.reason ?? ''] ??
    'The host service is not installed or cannot be reached.'
  );
}
