import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  createKeyVerifier,
  deriveKeyFromPassword,
  generateSalt,
  keyMatchesVerifier,
  type EventStore,
  type SealableSecretCipher,
} from '@verity/store';
import type { SecretStatus } from './attention.js';
import { bearerToken, type AuthTokenRegistry } from './auth.js';
import type { DevicePairingManager } from './device-pairing.js';
import { createUnlockThrottle } from './unlock-throttle.js';

const deviceLabelField = z.string().trim().min(1).max(100).optional();

// Unlock keeps the historical floor so an existing shorter password can still
// open the store; only initialization applies the stronger new-password policy.
const secretUnlockBody = z.object({
  password: z.string().min(8).max(1024),
  deviceLabel: deviceLabelField,
});

const secretInitBody = z.object({
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
export interface SecretLifecycleRouteDeps {
  store: Pick<EventStore, 'insertSecretKeyMetaIfAbsent' | 'getSecretKeyMeta'>;
  readStatus: () => Promise<SecretStatus>;
  secretCipher?: SealableSecretCipher | undefined;
  devicePairing?: DevicePairingManager | undefined;
  authRegistry?: AuthTokenRegistry | undefined;
  unlockClientIdentity?: ((request: FastifyRequest) => string | undefined) | undefined;
  onSecretUnlocked?: (() => Promise<void>) | undefined;
  recoverQueuedTurns: (reason: 'secret-init' | 'secret-unlock') => void;
}

function createDeviceTokenMinter(
  authRegistry: AuthTokenRegistry | undefined,
): (label: string | undefined) => Promise<{ token: string; tokenId: string } | undefined> {
  return async (label) => {
    if (authRegistry === undefined) return undefined;
    authRegistry.enable();
    const minted = await authRegistry.mint(label ?? null);
    return { token: minted.token, tokenId: minted.id };
  };
}

/** Registers status, initialization, and unlock for the encrypted secret store. */
export function registerSecretLifecycleRoutes(
  app: FastifyInstance,
  deps: SecretLifecycleRouteDeps,
): void {
  const unlockThrottle = createUnlockThrottle();
  const mintDeviceToken = createDeviceTokenMinter(deps.authRegistry);
  // scrypt runs off the event loop, but every invocation still occupies a
  // libuv worker and about 64 MB. Serialize pre-auth derivations so a concurrent
  // burst cannot queue work faster than the failure throttle can observe it.
  let passwordDerivationInFlight = false;

  const acquirePasswordDerivation = (): (() => void) | undefined => {
    if (passwordDerivationInFlight) return undefined;
    passwordDerivationInFlight = true;
    return () => {
      passwordDerivationInFlight = false;
    };
  };

  const rejectBusyDerivation = (reply: FastifyReply) => {
    reply.header('retry-after', '1');
    reply.code(429);
    return { error: 'password verification is busy — try again later' };
  };

  app.get('/secret/status', async (): Promise<{ status: SecretStatus }> => ({
    status: await deps.readStatus(),
  }));

  app.post('/secret/init', { bodyLimit: 4_096 }, async (request, reply) => {
    // Keep this pre-auth body far below the media-sized global limit so an
    // unauthenticated caller cannot make the server buffer tens of megabytes.
    const cipher = deps.secretCipher;
    if (cipher === undefined) {
      reply.code(409);
      return { error: 'secret store is not managed by this deployment' };
    }
    // Initialization shares the unlock throttle: this route is pre-auth, and
    // without it the scrypt derivation below is an unauthenticated CPU and
    // memory sink (~100 ms, ~64 MB per call) wherever pairing is not wired.
    const throttleIdentity = deps.unlockClientIdentity?.(request) ?? request.ip;
    const gate = unlockThrottle.check(throttleIdentity);
    if (!gate.allowed) {
      if (gate.retryAfterMs !== undefined)
        reply.header('retry-after', String(Math.ceil(gate.retryAfterMs / 1000)));
      reply.code(429);
      return { error: 'too many attempts — try again later' };
    }
    const { password, deviceLabel } = secretInitBody.parse(request.body);
    // Re-initializing an open store would derive a different key than the one
    // its existing secrets use; re-keying is a separate operation.
    if (!cipher.isSealed()) {
      reply.code(409);
      return { error: 'secret store is already unlocked' };
    }
    const releaseDerivation = acquirePasswordDerivation();
    if (releaseDerivation === undefined) return rejectBusyDerivation(reply);
    if (deps.devicePairing !== undefined) {
      const bootstrap = request.headers['x-verity-pairing'];
      if (typeof bootstrap !== 'string' || !deps.devicePairing.consumeBootstrap(bootstrap)) {
        releaseDerivation();
        unlockThrottle.recordFailure(throttleIdentity);
        reply.code(401);
        return { error: 'valid device pairing is required' };
      }
    }
    const salt = generateSalt();
    let key: string;
    try {
      key = await deriveKeyFromPassword(password, salt);
    } finally {
      releaseDerivation();
    }
    const won = await deps.store.insertSecretKeyMetaIfAbsent({
      salt,
      verifier: createKeyVerifier(key),
    });
    // The atomic insert closes the first-run race: the loser must never unlock
    // the store using its divergent key.
    if (!won) {
      unlockThrottle.recordFailure(throttleIdentity);
      reply.code(409);
      return { error: 'a master password is already set — use /secret/unlock' };
    }
    cipher.unlock(key);
    // Arm authentication before deferred activation. If activation fails, no
    // token is minted and protected routes remain inaccessible.
    deps.authRegistry?.enable();
    try {
      await deps.onSecretUnlocked?.();
    } catch (error: unknown) {
      request.log.error({ err: error }, 'Post-unlock activation failed');
      // Initialization persisted the verifier but issued no token. Re-seal so
      // /secret/unlock remains the sole retryable recovery path.
      cipher.seal();
      reply.code(503);
      return { error: 'secret store unlocked, but broker activation is still pending' };
    }
    // Mint only after every deferred authority is active; otherwise a failed
    // activation could orphan a valid device token.
    const auth = await mintDeviceToken(deviceLabel);
    unlockThrottle.recordSuccess(throttleIdentity);
    deps.recoverQueuedTurns('secret-init');
    return { status: 'unlocked' as const, ...auth };
  });

  app.post('/secret/unlock', { bodyLimit: 4_096 }, async (request, reply) => {
    // This route is also pre-auth, so it receives the same tight body limit as
    // initialization instead of inheriting the media-sized global limit.
    const cipher = deps.secretCipher;
    if (cipher === undefined) {
      reply.code(409);
      return { error: 'secret store is not managed by this deployment' };
    }
    if (deps.devicePairing !== undefined) {
      const existingDevice =
        deps.authRegistry?.verify(bearerToken(request.headers.authorization)) === true;
      const bootstrap = request.headers['x-verity-pairing'];
      if (!existingDevice && typeof bootstrap !== 'string') {
        reply.code(401);
        return { error: 'valid device pairing is required' };
      }
    }
    // Reject locked-out clients before the expensive password derivation.
    const throttleIdentity = deps.unlockClientIdentity?.(request) ?? request.ip;
    const gate = unlockThrottle.check(throttleIdentity);
    if (!gate.allowed) {
      if (gate.retryAfterMs !== undefined)
        reply.header('retry-after', String(Math.ceil(gate.retryAfterMs / 1000)));
      reply.code(429);
      return { error: 'too many attempts — try again later' };
    }
    const { password, deviceLabel } = secretUnlockBody.parse(request.body);
    const meta = await deps.store.getSecretKeyMeta();
    if (meta === undefined) {
      reply.code(409);
      return { error: 'no master password set — use /secret/init' };
    }
    const releaseDerivation = acquirePasswordDerivation();
    if (releaseDerivation === undefined) return rejectBusyDerivation(reply);
    let key: string;
    try {
      key = await deriveKeyFromPassword(password, meta.salt);
    } finally {
      releaseDerivation();
    }
    if (!keyMatchesVerifier(key, meta.verifier)) {
      unlockThrottle.recordFailure(throttleIdentity);
      reply.code(401);
      return { error: 'incorrect master password' };
    }
    // Consume the one-shot bootstrap only after password verification, so an
    // unauthenticated guess cannot burn a valid pairing attempt.
    if (deps.devicePairing !== undefined) {
      const existingDevice =
        deps.authRegistry?.verify(bearerToken(request.headers.authorization)) === true;
      const bootstrap = request.headers['x-verity-pairing'];
      if (!existingDevice && !deps.devicePairing.consumeBootstrap(bootstrap as string)) {
        reply.code(401);
        return { error: 'valid device pairing is required' };
      }
    }
    unlockThrottle.recordSuccess(throttleIdentity);
    cipher.unlock(key);
    try {
      await deps.onSecretUnlocked?.();
    } catch (error: unknown) {
      request.log.error({ err: error }, 'Post-unlock activation failed');
      cipher.seal();
      reply.code(503);
      return { error: 'secret store unlocked, but broker activation is still pending' };
    }
    // Enroll the device only after broker activation succeeds.
    const auth = await mintDeviceToken(deviceLabel);
    deps.recoverQueuedTurns('secret-unlock');
    return { status: 'unlocked' as const, ...auth };
  });
}
