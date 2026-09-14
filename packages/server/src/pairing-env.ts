import { closeSync, mkdirSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDevicePairingManager, type DevicePairingManager } from './device-pairing.js';

/** Classify the real process startup paths that expose or back the public API. */
export function serverStartupRequiresPairing(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): boolean {
  if (argv[2] === 'managed-gateway') return false;
  if (argv[2] === 'direct-server') return true;
  return !env['VERITY_MANAGED_DEPLOYMENT_ID']?.trim();
}

/**
 * Resolve the installer-provisioned device-pairing wiring from the process
 * environment.
 *
 * A public, non-managed Server must not come up without pairing material: until
 * a master password exists the auth gate admits every caller, so a reachable
 * `/secret/init` with no pairing bootstrap would let any network peer set the
 * password, mint itself a device token, and — through the Runner's Docker
 * socket — own the host. The managed profile authenticates unlock through the
 * Gateway's verified client-identity header, and tests build the embedded
 * server directly; both legitimately run without pairing, which is why the
 * requirement is passed explicitly instead of applied globally.
 */
export async function devicePairingFromEnv(options: {
  env: Record<string, string | undefined>;
  pairingRequired: boolean;
  /** Where the durable consumed-code markers live (`.pairing-code-consumed*`). */
  verityRoot: string;
}): Promise<DevicePairingManager | undefined> {
  const { env, verityRoot } = options;
  const pairingIdentityPath = env['VERITY_PAIRING_IDENTITY_KEY_PATH'];
  const pairingCodePath = env['VERITY_PAIRING_CODE_PATH'];
  const pairingExpiresAt = env['VERITY_PAIRING_EXPIRES_AT'];
  const pairingExpiresAtPath = env['VERITY_PAIRING_EXPIRES_AT_PATH'];
  if (pairingExpiresAt && pairingExpiresAtPath) {
    throw new Error(
      'VERITY_PAIRING_EXPIRES_AT and VERITY_PAIRING_EXPIRES_AT_PATH are mutually exclusive',
    );
  }
  const resolvedPairingExpiresAt = pairingExpiresAtPath
    ? (await readFile(pairingExpiresAtPath, 'utf8')).trim()
    : pairingExpiresAt;
  const pairingParts = [pairingIdentityPath, pairingCodePath, resolvedPairingExpiresAt].filter(
    (value) => value !== undefined && value !== '',
  );
  if (pairingParts.length !== 0 && pairingParts.length !== 3) {
    throw new Error(
      'VERITY_PAIRING_IDENTITY_KEY_PATH, VERITY_PAIRING_CODE_PATH and one pairing expiry source must be configured together',
    );
  }
  if (pairingParts.length === 0) {
    if (options.pairingRequired) {
      throw new Error(
        'public Server startup requires pairing material: configure VERITY_PAIRING_IDENTITY_KEY_PATH, VERITY_PAIRING_CODE_PATH and VERITY_PAIRING_EXPIRES_AT(_PATH) (deploy/bin/verity-pairing-material provisions them)',
      );
    }
    return undefined;
  }
  return createDevicePairingManager({
    privateKeyPem: await readFile(pairingIdentityPath!, 'utf8'),
    loadPairingMaterial: () => ({
      pairingCode: readFileSync(pairingCodePath!, 'utf8').trim(),
      expiresAt: pairingExpiresAtPath
        ? readFileSync(pairingExpiresAtPath, 'utf8').trim()
        : resolvedPairingExpiresAt!,
    }),
    loadConsumedCodeHash: () => {
      const hashes = new Set<string>();
      try {
        for (const hash of readFileSync(join(verityRoot, '.pairing-code-consumed'), 'utf8')
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter(Boolean)) {
          hashes.add(hash);
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      try {
        for (const hash of readdirSync(join(verityRoot, '.pairing-code-consumed.d'))) {
          hashes.add(hash);
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return [...hashes];
    },
    storeConsumedCodeHash: (hash) => {
      const directory = join(verityRoot, '.pairing-code-consumed.d');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try {
        const fd = openSync(join(directory, hash), 'wx', 0o600);
        closeSync(fd);
        return true;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      }
    },
  });
}
