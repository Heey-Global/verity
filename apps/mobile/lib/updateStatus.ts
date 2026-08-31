import type * as ExpoUpdates from 'expo-updates';

/**
 * Runtime facts about the EAS update the app is currently running, used to prove
 * in-app that an OTA actually landed.
 *
 * EAS does NOT assign an incrementing version number to updates — every update it
 * delivers is identified by a stable `updateId` (a UUID) plus a `createdAt`
 * timestamp. `isEmbeddedLaunch` is the key signal: `true` means the app is running
 * the JS bundle baked into the native binary (no OTA applied yet), `false` means a
 * downloaded OTA update is live. So a non-embedded launch with an id/date is the
 * "the OTA worked" confirmation.
 */
export type RunningUpdate = {
  isEnabled: boolean;
  isEmbeddedLaunch: boolean;
  updateId: string | null;
  createdAt: Date | null;
};

export type RunningUpdateLabel = {
  /** True when a downloaded OTA update is running (not the embedded bundle). */
  active: boolean;
  /** Compact label for the settings footer. */
  text: string;
};

type UpdatesConstants = Pick<
  typeof ExpoUpdates,
  'isEnabled' | 'isEmbeddedLaunch' | 'updateId' | 'createdAt'
>;

/**
 * Read the running-update facts from expo-updates. Guards the disabled case
 * (Expo Go / dev / a build with updates off) so the other constants are only
 * touched when updates are actually enabled.
 */
export function readRunningUpdate(client: UpdatesConstants): RunningUpdate {
  if (!client.isEnabled) {
    return { isEnabled: false, isEmbeddedLaunch: false, updateId: null, createdAt: null };
  }
  return {
    isEnabled: true,
    isEmbeddedLaunch: client.isEmbeddedLaunch,
    updateId: client.updateId,
    createdAt: client.createdAt,
  };
}

/** Turn the running-update facts into a short footer label. */
export function describeRunningUpdate(update: RunningUpdate): RunningUpdateLabel {
  if (!update.isEnabled) return { active: false, text: 'off' };
  // The embedded launch runs the bundle shipped inside the native binary — no OTA
  // has been applied on this build yet.
  if (update.isEmbeddedLaunch || !update.updateId) {
    return { active: false, text: 'built-in' };
  }
  const shortId = update.updateId.slice(0, 8);
  // Match the settings screen's other timestamps (toLocaleString).
  const when = update.createdAt ? update.createdAt.toLocaleString() : null;
  return { active: true, text: when ? `${shortId} · ${when}` : shortId };
}
