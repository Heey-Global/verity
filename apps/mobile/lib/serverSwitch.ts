import { useSyncExternalStore } from 'react';

import { restoreUnprotectedAuthToken } from './authToken';
import { setVerityBaseUrl } from './client';
import {
  activateServerProfile,
  bumpServerRevision,
  getOtherServerProfiles,
  getServerRevision,
  subscribeServerRevision,
} from './serverProfile';

/**
 * Switch the app to another server it knows. The app shell remounts on the new
 * revision, so every store, live connection and screen starts over for that
 * server, and the onboarding gate asks to unlock it when it needs to.
 */
export async function switchToServer(serverId: string): Promise<void> {
  const target = getOtherServerProfiles().find((profile) => profile.serverId === serverId);
  if (target === undefined) throw new Error('This server is no longer known to the app.');
  await activateServerProfile(target);
  await setVerityBaseUrl(target.activeUrl);
  await restoreUnprotectedAuthToken(target.activeUrl).catch(() => false);
  bumpServerRevision();
}

/** Make the other servers' unprotected credentials usable without a prompt. */
export async function restoreOtherServerCredentials(): Promise<void> {
  for (const profile of getOtherServerProfiles())
    await restoreUnprotectedAuthToken(profile.activeUrl).catch(() => false);
}

export function useServerRevision(): number {
  return useSyncExternalStore(subscribeServerRevision, getServerRevision, getServerRevision);
}
