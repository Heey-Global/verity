import type { VeritySettingsRecord } from '@verity/store';

// The state of the paid Uplink features as Core reports it: the operator's
// switches, the diagnostics the settings show, and whether team invitations
// can work. Kept apart from the control client, which only computes them.

/** Operator switches for the paid features, read from the settings row. A
 * feature is used only when the Uplink grants it AND its switch is on. */
export interface PremiumFeatureSwitches {
  sharing: boolean;
  remoteAccess: boolean;
}

interface PremiumFeatureState {
  /** The Uplink included the feature in the current lease. */
  granted: boolean;
  /** The operator left the feature switched on. */
  enabled: boolean;
  /** `granted && enabled` — what actually works right now. */
  effective: boolean;
}

export interface UplinkDiagnostics {
  control: 'idle' | 'connected' | 'connecting' | 'reconnecting' | 'rejected' | 'disabled';
  sharing: 'ready' | 'unavailable';
  entitlement?: 'unchecked' | 'checked';
  idleReason?: 'no-demand' | 'not-granted';
  remoteControl: 'ready' | 'unavailable';
  reason?: 'unknown_key' | 'revoked' | 'expired';
  lastCloseCode?: number;
  /** Per-feature grant/switch/effective breakdown. Always present from the
   * client; optional in the type so hand-built fixtures stay valid. */
  features?: { sharing: PremiumFeatureState; remoteAccess: PremiumFeatureState };
}

export function premiumFeatureSwitches(
  settings: Pick<VeritySettingsRecord, 'premiumSharingEnabled' | 'premiumRemoteAccessEnabled'>,
): PremiumFeatureSwitches {
  return {
    sharing: settings.premiumSharingEnabled !== false,
    remoteAccess: settings.premiumRemoteAccessEnabled !== false,
  };
}

/**
 * Whether team invitations can reach Uplink, and if not, why:
 * - `available`: the lease grants `team-sharing` and the connection negotiated team v1.
 * - `uplink_offline`: not known yet or temporarily unreachable; queued work waits.
 * - `not_entitled`: the last lease did not grant `team-sharing`.
 * - `not_negotiated`: the connected Uplink grants it but did not select team v1.
 * - `unavailable`: this server offers no team v1 to Uplink, has no usable Uplink
 *   key, or Uplink refused the key.
 * Only `available` and `uplink_offline` let an invitation be created: the others
 * would leave it waiting for a link that cannot come.
 */
export type TeamAvailability =
  'available' | 'uplink_offline' | 'not_entitled' | 'not_negotiated' | 'unavailable';

/** Whether an invitation created now can get its link once Uplink answers. */
export function teamInvitationsPossible(availability: TeamAvailability): boolean {
  return availability === 'available' || availability === 'uplink_offline';
}
