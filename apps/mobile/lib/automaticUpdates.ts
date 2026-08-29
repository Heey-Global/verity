import * as Updates from 'expo-updates';

const CHECK_TIMEOUT_MS = 5_000;
const FETCH_TIMEOUT_MS = 30_000;

type UpdatesClient = Pick<
  typeof Updates,
  'isEnabled' | 'checkForUpdateAsync' | 'fetchUpdateAsync' | 'reloadAsync'
>;

export type StartupUpdateResult = 'disabled' | 'current' | 'reloading' | 'failed';
export type SerialUpdateResult = StartupUpdateResult | 'busy';

function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Update request timed out')), timeoutMs);
  });
  return Promise.race([task, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Fetch and apply a compatible EAS update before the main UI becomes interactive.
 * Fail open when Expo or the network is unavailable so an update outage can never
 * prevent Verity from launching.
 */
export async function applyStartupUpdate(
  client: UpdatesClient = Updates,
): Promise<StartupUpdateResult> {
  if (!client.isEnabled) return 'disabled';

  try {
    const check = await withTimeout(client.checkForUpdateAsync(), CHECK_TIMEOUT_MS);
    if (!check.isAvailable && !check.isRollBackToEmbedded) return 'current';

    const fetched = await withTimeout(client.fetchUpdateAsync(), FETCH_TIMEOUT_MS);
    if (!fetched.isNew && !fetched.isRollBackToEmbedded) return 'current';

    await client.reloadAsync();
    return 'reloading';
  } catch {
    return 'failed';
  }
}

/**
 * Serializes foreground/poll-triggered update checks. Expo update fetch/reload
 * calls are process-global; if a foreground event and a timer tick overlap, only
 * one should touch the update service.
 */
export function createSerialUpdateChecker(
  client: UpdatesClient = Updates,
): () => Promise<SerialUpdateResult> {
  let inFlight = false;
  return async () => {
    if (inFlight) return 'busy';
    inFlight = true;
    try {
      return await applyStartupUpdate(client);
    } finally {
      inFlight = false;
    }
  };
}

// One process-wide checker is shared by foreground polling and the manual
// Settings action. Expo update operations are global, so separate callers must
// never fetch or reload concurrently.
export const checkForAppUpdate = createSerialUpdateChecker();
