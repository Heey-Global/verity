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

/** How often a refusal is checked again with Uplink while nothing else connects. */
export const TEAM_RECHECK_MS = 10 * 60_000;

/**
 * The team availability the routes report. A refusal is the last lease's
 * answer, and a parked client gets no other: nothing creates team demand once
 * inviting is refused. So a refusal read from a parked client starts a fresh
 * check, at most every TEAM_RECHECK_MS, and team sharing granted later takes
 * effect without a restart. Without a control client no link can ever appear.
 */
export function teamSharingStatus(
  uplink:
    | {
        teamAvailability(): TeamAvailability;
        diagnostics(): Pick<UplinkDiagnostics, 'control'>;
        checkEntitlements(): Promise<unknown>;
      }
    | undefined,
  now: () => number = Date.now,
): () => TeamAvailability {
  let checkedAt: number | undefined;
  return () => {
    if (uplink === undefined) return 'unavailable';
    const availability = uplink.teamAvailability();
    if (
      !teamInvitationsPossible(availability) &&
      uplink.diagnostics().control === 'idle' &&
      (checkedAt === undefined || now() - checkedAt >= TEAM_RECHECK_MS)
    ) {
      checkedAt = now();
      // The answer reaches the next read; a failed check leaves the last one.
      void uplink.checkEntitlements().catch(() => undefined);
    }
    return availability;
  };
}
