import * as SecureStore from 'expo-secure-store';
import { z } from 'zod';

const KEY = 'verity.teamJoin.v1';
const text = z.string().min(1).max(1024);
const schema = z.object({
  version: z.literal(1),
  link: z.object({
    invitationId: text,
    secret: z.string().max(128),
    expiresAt: z.number(),
    serverId: text,
    identityKey: text,
    tlsPin: text,
    coreOrigin: text,
    uplinkOrigin: text,
    installationId: text,
    installationHandle: text,
    display: z.object({ inviterName: text, projectName: text }).optional(),
  }),
  displayName: z.string().min(1).max(80),
  admission: z.object({ sessionId: text, redemptionId: text, ticket: text, expiresAt: z.number() }),
  recoveryExpiresAt: z.number().optional(),
  credential: z.object({ token: text, tokenId: text, projectId: text }).optional(),
});
export type TeamJoinProgress = z.infer<typeof schema>;

/** A single bounded keychain record; never put invitation or device secrets in AsyncStorage. */
export async function loadTeamJoinProgress(): Promise<TeamJoinProgress | null> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (raw === null) return null;
  if (raw.length > 16_384) throw new Error('Invalid saved join progress.');
  const progress = schema.parse(JSON.parse(raw));
  if (
    progress.credential === undefined &&
    Math.min(progress.link.expiresAt, progress.recoveryExpiresAt ?? progress.admission.expiresAt) <=
      Date.now()
  ) {
    await clearTeamJoinProgress();
    throw new Error('The recovery window has ended. Ask for a new invitation.');
  }
  return progress;
}

export async function saveTeamJoinProgress(progress: TeamJoinProgress): Promise<void> {
  const value = JSON.stringify(schema.parse(progress));
  await SecureStore.setItemAsync(KEY, value, {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
  });
  // A failed write must never be treated as permission to activate the person.
  if ((await SecureStore.getItemAsync(KEY)) !== value)
    throw new Error('Could not save join progress on this device. Try again.');
}

export async function clearTeamJoinProgress(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}
