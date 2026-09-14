import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DevicePairingRejectedError } from './device-pairing.js';
import { devicePairingFromEnv, serverStartupRequiresPairing } from './pairing-env.js';

const PAIRING_CODE = 'installer-pairing-code-0123456789abcdef';

let tempRoot: string | null = null;

/** Pairing material files as `deploy/bin/verity-pairing-material` provisions
 *  them, in a fresh temp dir that doubles as the verity root. */
function material(): { env: Record<string, string>; verityRoot: string } {
  tempRoot = mkdtempSync(join(tmpdir(), 'verity-pairing-env-'));
  const { privateKey } = generateKeyPairSync('ed25519');
  const identityPath = join(tempRoot, 'identity.pem');
  const codePath = join(tempRoot, 'pairing-code');
  writeFileSync(identityPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  writeFileSync(codePath, `${PAIRING_CODE}\n`);
  return {
    env: {
      VERITY_PAIRING_IDENTITY_KEY_PATH: identityPath,
      VERITY_PAIRING_CODE_PATH: codePath,
      VERITY_PAIRING_EXPIRES_AT: new Date(Date.now() + 60 * 60_000).toISOString(),
    },
    verityRoot: tempRoot,
  };
}

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

describe('devicePairingFromEnv', () => {
  it('requires pairing for both the explicit and package-start public CLI paths', () => {
    expect(serverStartupRequiresPairing(['node', 'dist/main.js', 'direct-server'], {})).toBe(true);
    expect(serverStartupRequiresPairing(['node', 'dist/main.js'], {})).toBe(true);
    expect(
      serverStartupRequiresPairing(['node', 'dist/main.js'], {
        VERITY_MANAGED_DEPLOYMENT_ID: 'deployment-1',
      }),
    ).toBe(false);
    expect(serverStartupRequiresPairing(['node', 'dist/main.js', 'managed-gateway'], {})).toBe(
      false,
    );
  });

  it('refuses to boot a public server without pairing material', async () => {
    // The silent failure this guards: until a master password exists the auth
    // gate admits everyone, so a direct server that came up without pairing
    // would expose /secret/init as an unauthenticated takeover of the host.
    await expect(
      devicePairingFromEnv({ env: {}, pairingRequired: true, verityRoot: '/nonexistent' }),
    ).rejects.toThrow(/public Server startup requires pairing material/);
  });

  it('stays optional for a managed backend and embedded tests', async () => {
    await expect(
      devicePairingFromEnv({ env: {}, pairingRequired: false, verityRoot: '/nonexistent' }),
    ).resolves.toBeUndefined();
  });

  it('rejects partial pairing configuration in either mode', async () => {
    const { env, verityRoot } = material();
    const partial = { VERITY_PAIRING_IDENTITY_KEY_PATH: env['VERITY_PAIRING_IDENTITY_KEY_PATH']! };
    for (const pairingRequired of [true, false]) {
      await expect(
        devicePairingFromEnv({ env: partial, pairingRequired, verityRoot }),
      ).rejects.toThrow(/configured together/);
    }
  });

  it('rejects configuring both expiry sources at once', async () => {
    const { env, verityRoot } = material();
    await expect(
      devicePairingFromEnv({
        env: { ...env, VERITY_PAIRING_EXPIRES_AT_PATH: join(verityRoot, 'expiry') },
        pairingRequired: true,
        verityRoot,
      }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it('builds a manager whose code burn survives a process restart', async () => {
    const { env, verityRoot } = material();
    const first = await devicePairingFromEnv({ env, pairingRequired: true, verityRoot });
    expect(first).toBeDefined();
    const { bootstrapToken } = first!.redeem(PAIRING_CODE);
    expect(first!.consumeBootstrap(bootstrapToken)).toBe(true);

    // A second resolution over the same verity root models a restarted server:
    // the durable consumed-code marker must keep the installer code single-use,
    // or a crash-loop would hand out fresh bootstraps to whoever guesses first.
    const restarted = await devicePairingFromEnv({ env, pairingRequired: true, verityRoot });
    expect(() => restarted!.redeem(PAIRING_CODE)).toThrow(DevicePairingRejectedError);
  });
});
