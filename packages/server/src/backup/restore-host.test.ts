import { randomUUID, X509Certificate } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { devicePairingFromEnv } from '../pairing-env.js';
import { generateBackupKeys } from './crypto.js';
import { writeBackupIdentityFixture } from './testing.js';
import { createRestoreHost } from './restore-host.js';
import { publishRestoreHostState } from './restore-host-state.js';
import { validateReadableIdentity } from './restore-identity.js';
import type { RestoreJob } from './restore-job.js';

it('preserves deployment keys and CA while reissuing the pinned host leaf and rotating installation credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-host-'));
  try {
    const { host } = await generateBackupKeys();
    const sourceId = randomUUID();
    await writeBackupIdentityFixture(root, host, sourceId);
    const job: RestoreJob = {
      format: 1,
      id: randomUUID(),
      installationId: randomUUID(),
      selection: {
        source: '/copied/backup',
        repository: sourceId + '-r1',
        sequence: 1,
        kind: 'manual',
        newIdentity: false,
      },
      verified: {
        image: 'ghcr.io/heey-global/verity/verity-server@sha256:' + 'a'.repeat(64),
        manifestHash: 'b'.repeat(64),
        schema: 'schema',
        architecture: 'amd64',
        deploymentId: 'deployment-fixture',
        sourceInstallationId: sourceId,
      },
      phase: 'staging',
      startedAt: 1,
      updatedAt: 1,
    };
    const stage = createRestoreHost({
      root,
      addresses: ['192.0.2.1', '2001:db8::1'],
      hostname: 'restored.example',
      serverUid: process.getuid?.() ?? 1000,
      serverGid: process.getgid?.() ?? 1000,
    });
    const ca = await readFile(join(root, 'ca.pem'));
    await mkdir(join(root, job.id));
    await writeFile(
      join(root, job.id, 'database'),
      JSON.stringify({ jobId: job.id, password: 'a'.repeat(64) }),
    );
    await stage(job, root, ca);
    const destination = join(root, job.id, 'host');
    const files = new Map<string, Buffer>();
    for (const name of [
      'deployment-id',
      'pairing-identity.pem',
      'tls-ca-cert.pem',
      'tls-key.pem',
      'tls-cert.pem',
    ])
      files.set(name, await readFile(join(destination, name)));
    expect(validateReadableIdentity(files).deploymentId).toBe('deployment-fixture');
    expect(files.get('pairing-identity.pem')).toEqual(
      await readFile(join(root, 'identity/pairing-identity.pem')),
    );
    expect(files.get('tls-ca-cert.pem')).toEqual(
      await readFile(join(root, 'identity/tls-ca-cert.pem')),
    );
    expect(files.get('tls-key.pem')).toEqual(await readFile(join(root, 'identity/tls-key.pem')));
    const certificate = new X509Certificate(files.get('tls-cert.pem')!);
    expect(certificate.checkIP('192.0.2.1')).toBe('192.0.2.1');
    expect(certificate.checkIP('2001:db8::1')).toBe('2001:db8::1');
    expect(certificate.checkHost('restored.example')).toBe('restored.example');
    expect(await readFile(join(destination, 'installation-id'), 'utf8')).toBe(job.installationId);
    expect((await stat(join(destination, 'tls-ca-key.pem'))).mode & 0o077).toBe(0);
    expect((await stat(join(destination, 'tls-ca-cert.pem'))).mode & 0o777).toBe(0o644);
    const live = join(root, 'live');
    await mkdir(live);
    await publishRestoreHostState(destination, live);
    expect(await readFile(join(live, 'installation-id'), 'utf8')).toBe(job.installationId);
    expect(await readFile(join(live, 'postgres-password'), 'utf8')).toBe('a'.repeat(64));
    expect(await readFile(join(live, 'pairing-identity.pem'))).toEqual(
      files.get('pairing-identity.pem'),
    );
    const pairing = await devicePairingFromEnv({
      env: {
        VERITY_PAIRING_IDENTITY_KEY_PATH: join(live, 'pairing-identity.pem'),
        VERITY_PAIRING_CODE_PATH: join(live, 'pairing-code'),
        VERITY_PAIRING_EXPIRES_AT_PATH: join(live, 'pairing-expires-at'),
      },
      pairingRequired: true,
      verityRoot: live,
    });
    expect(pairing).toBeDefined();
    // Normal startup needs complete material, while recovery must grant no pairing capability.
    const disabledCode = (await readFile(join(live, 'pairing-code'), 'utf8')).trim();
    expect(disabledCode).toMatch(/^[a-f0-9]{64}$/);
    expect(() => pairing!.redeem(disabledCode)).toThrow();
    expect(Date.parse(await readFile(join(live, 'pairing-expires-at'), 'utf8'))).toBeLessThan(
      Date.now(),
    );
    const replacement = {
      ...job,
      id: randomUUID(),
      selection: { ...job.selection, newIdentity: true },
    };
    await mkdir(join(root, replacement.id));
    await writeFile(
      join(root, replacement.id, 'database'),
      JSON.stringify({ jobId: replacement.id, password: 'b'.repeat(64) }),
    );
    await createRestoreHost({
      root,
      addresses: [],
      hostname: '2001:db8::2',
      serverUid: process.getuid?.() ?? 1000,
      serverGid: process.getgid?.() ?? 1000,
    })(replacement, root, ca);
    const newHost = join(root, replacement.id, 'host');
    expect(
      new X509Certificate(await readFile(join(newHost, 'tls-cert.pem'))).checkIP('2001:db8::2'),
    ).toBe('2001:db8::2');
    expect(await readFile(join(newHost, 'deployment-id'), 'utf8')).not.toBe('deployment-fixture');
    expect(await readFile(join(newHost, 'pairing-identity.pem'))).not.toEqual(
      files.get('pairing-identity.pem'),
    );
    expect(await readFile(join(newHost, 'tls-ca-cert.pem'))).not.toEqual(
      files.get('tls-ca-cert.pem'),
    );
    const newPairing = await devicePairingFromEnv({
      env: {
        VERITY_PAIRING_IDENTITY_KEY_PATH: join(newHost, 'pairing-identity.pem'),
        VERITY_PAIRING_CODE_PATH: join(newHost, 'pairing-code'),
        VERITY_PAIRING_EXPIRES_AT_PATH: join(newHost, 'pairing-expires-at'),
      },
      pairingRequired: true,
      verityRoot: newHost,
    });
    expect(newPairing!.identity()).not.toEqual(pairing!.identity());
    const newCode = (await readFile(join(newHost, 'pairing-code'), 'utf8')).trim();
    expect(newCode).not.toBe(disabledCode);
    expect(() => newPairing!.redeem(newCode)).toThrow();
    ca.fill(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
