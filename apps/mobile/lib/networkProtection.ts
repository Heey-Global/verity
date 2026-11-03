import type { VeritySettings } from '@verity/mobile';

export function networkProtectionStatus(settings: VeritySettings | null): string {
  if (settings === null) return 'Loading…';
  if (settings.projectEgressEnabled === undefined || settings.projectEgressAvailable === undefined)
    return 'Server update required';
  if (!settings.projectEgressAvailable) return 'Host service unavailable';
  return settings.projectEgressEnabled ? 'On' : 'Off';
}
