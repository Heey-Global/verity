import type { VeritySettingsRecord } from '@verity/store';
import type { PreviewShareManager } from './preview-share-manager.js';
import { premiumFeatureSwitches, type UplinkControlClient } from './uplink-control-client.js';

/** Apply local policy before attempting public-link cleanup. */
export async function applyPremiumFeatureSwitches(
  settings: VeritySettingsRecord,
  client: Pick<UplinkControlClient, 'applyFeatureSwitches'>,
  shares: Pick<PreviewShareManager, 'disableAll'> | undefined,
): Promise<void> {
  const next = premiumFeatureSwitches(settings);
  client.applyFeatureSwitches(next);
  // A saved off preference must not erase unfinished public-link revocations.
  if (!next.sharing) {
    await shares?.disableAll('online sharing switched off in settings');
  }
}
