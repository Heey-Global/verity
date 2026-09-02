import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SecretStatus } from './attention.js';
import type { AuthTokenRegistry } from './auth.js';

const deviceLabelField = z.string().trim().min(1).max(100).optional();

// Unlock keeps the historical floor so an existing shorter password can still
// open the store; only initialization applies the stronger new-password policy.
export const secretUnlockBody = z.object({
  password: z.string().min(8).max(1024),
  deviceLabel: deviceLabelField,
});

export const secretInitBody = z.object({
  password: z
    .string()
    .min(12)
    .max(1024)
    .refine((password) => new Set(password).size >= 5, {
      message: 'password is too weak (use a longer, more varied passphrase)',
    }),
  deviceLabel: deviceLabelField,
});

/** Registers the shared at-rest-encryption status surface. */
export function registerSecretStatusRoute(
  app: FastifyInstance,
  readStatus: () => Promise<SecretStatus>,
): void {
  app.get('/secret/status', async (): Promise<{ status: SecretStatus }> => ({
    status: await readStatus(),
  }));
}

/** Creates the post-unlock device enrollment operation used by init and unlock. */
export function createDeviceTokenMinter(
  authRegistry: AuthTokenRegistry | undefined,
): (label: string | undefined) => Promise<{ token: string; tokenId: string } | undefined> {
  return async (label) => {
    if (authRegistry === undefined) return undefined;
    authRegistry.enable();
    const minted = await authRegistry.mint(label ?? null);
    return { token: minted.token, tokenId: minted.id };
  };
}
