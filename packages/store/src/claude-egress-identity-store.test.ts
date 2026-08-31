import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSecretCipher } from './crypto.js';
import { migrateToLatest } from './db.js';
import { EventStore, type ClaudeEgressCaRecord } from './store.js';
import { createRawDb, truncateAll, type RawTestDb } from './testing.js';

// Test-only 32-byte key, built at runtime so no secret-shaped literal lands in
// source (not a real secret).
const KEY = Buffer.alloc(32, 0x22).toString('hex');

let raw: RawTestDb;
let store: EventStore;

beforeAll(async () => {
  raw = createRawDb();
  await migrateToLatest(raw.db);
  store = new EventStore(raw.db, createSecretCipher(KEY));
});

afterAll(async () => {
  await raw.close();
});

beforeEach(async () => {
  await truncateAll(raw.db);
});

// Neutral fixture PEM-ish strings — the cipher round-trips arbitrary bytes and
// nothing parses these as keys, so no secret-shaped PEM literal is needed.
const caRecord = (): ClaudeEgressCaRecord => ({
  caCertPem: 'ca-cert-fixture',
  caKeyPem: 'ca-private-key-fixture-value',
  gatewayServerName: 'claude-proxy.internal',
  gatewayCertPem: 'gateway-cert-fixture',
  gatewayKeyPem: 'gateway-private-key-fixture-value',
  caExpiresAt: new Date('2030-01-01T00:00:00.000Z'),
  gatewayExpiresAt: new Date('2027-01-01T00:00:00.000Z'),
});

describe('EventStore — Claude egress identity persistence', () => {
  it('returns undefined before the first CA issuance', async () => {
    await expect(store.getClaudeEgressCa()).resolves.toBeUndefined();
  });

  it('encrypts the CA + gateway private keys at rest but not the public certs', async () => {
    await store.upsertClaudeEgressCa(caRecord());

    const rawRow = await raw.db
      .selectFrom('claude_egress_ca')
      .select(['ca_cert_pem', 'ca_key_pem', 'gateway_cert_pem', 'gateway_key_pem'])
      .where('id', '=', 'global')
      .executeTakeFirst();
    expect(rawRow?.ca_key_pem?.startsWith('enc:v1:')).toBe(true);
    expect(rawRow?.ca_key_pem).not.toContain('ca-private-key-fixture-value');
    expect(rawRow?.gateway_key_pem?.startsWith('enc:v1:')).toBe(true);
    expect(rawRow?.gateway_key_pem).not.toContain('gateway-private-key-fixture-value');
    // Public certs stay plaintext.
    expect(rawRow?.ca_cert_pem).toBe('ca-cert-fixture');
    expect(rawRow?.gateway_cert_pem).toBe('gateway-cert-fixture');

    // getClaudeEgressCa decrypts symmetrically and round-trips the timestamps.
    await expect(store.getClaudeEgressCa()).resolves.toEqual(caRecord());
  });

  it('overwrites the singleton CA on re-issue (rotation)', async () => {
    await store.upsertClaudeEgressCa(caRecord());
    await store.upsertClaudeEgressCa({
      ...caRecord(),
      caKeyPem: 'rotated-ca-key',
      caCertPem: 'rotated-ca-cert',
    });
    const rows = await raw.db.selectFrom('claude_egress_ca').selectAll().execute();
    expect(rows).toHaveLength(1);
    await expect(store.getClaudeEgressCa()).resolves.toMatchObject({
      caKeyPem: 'rotated-ca-key',
      caCertPem: 'rotated-ca-cert',
    });
  });

  it('replaceClaudeEgressCa installs the new CA and wipes client certs atomically', async () => {
    const projectId = randomUUID();
    await store.upsertProject({
      id: projectId,
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await store.upsertClaudeEgressCa(caRecord());
    await store.upsertClaudeEgressClientCert({
      projectId,
      certPem: 'old-cert',
      keyPem: 'old-key',
      fingerprint256: 'a'.repeat(64),
      expiresAt: new Date('2027-06-01T00:00:00.000Z'),
    });

    await store.replaceClaudeEgressCa({
      ...caRecord(),
      caCertPem: 'rotated-ca-cert',
      caKeyPem: 'rotated-ca-key',
    });

    // The old-CA client cert is gone; the CA row is the rotated one.
    await expect(store.listClaudeEgressClientCerts()).resolves.toEqual([]);
    await expect(store.getClaudeEgressCa()).resolves.toMatchObject({
      caCertPem: 'rotated-ca-cert',
      caKeyPem: 'rotated-ca-key',
    });
    // The rotated CA key is still enciphered at rest.
    const rawRow = await raw.db
      .selectFrom('claude_egress_ca')
      .select('ca_key_pem')
      .where('id', '=', 'global')
      .executeTakeFirst();
    expect(rawRow?.ca_key_pem?.startsWith('enc:v1:')).toBe(true);
    expect(rawRow?.ca_key_pem).not.toContain('rotated-ca-key');
  });

  it('encrypts a project client key at rest but keeps cert + fingerprint plaintext', async () => {
    const projectId = randomUUID();
    await store.upsertProject({
      id: projectId,
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });

    await store.upsertClaudeEgressClientCert({
      projectId,
      certPem: 'client-cert-fixture',
      keyPem: 'client-private-key-fixture-value',
      fingerprint256: 'a'.repeat(64),
      expiresAt: new Date('2027-06-01T00:00:00.000Z'),
    });

    const rawRow = await raw.db
      .selectFrom('claude_egress_client_certs')
      .select(['cert_pem', 'key_pem', 'fingerprint256'])
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    expect(rawRow?.key_pem?.startsWith('enc:v1:')).toBe(true);
    expect(rawRow?.key_pem).not.toContain('client-private-key-fixture-value');
    expect(rawRow?.cert_pem).toBe('client-cert-fixture');
    expect(rawRow?.fingerprint256).toBe('a'.repeat(64));

    await expect(store.getClaudeEgressClientCert(projectId)).resolves.toEqual({
      projectId,
      certPem: 'client-cert-fixture',
      keyPem: 'client-private-key-fixture-value',
      fingerprint256: 'a'.repeat(64),
      expiresAt: new Date('2027-06-01T00:00:00.000Z'),
    });
  });

  it('lists client certs ordered by project and upserts on rotation', async () => {
    const [projectA, projectB] = [randomUUID(), randomUUID()].sort() as [string, string];
    for (const [index, projectId] of [projectA, projectB].entries()) {
      await store.upsertProject({
        id: projectId,
        owner: 'heey-global',
        repo: `verity-${index}`,
        containerName: `dev-${index}`,
        state: 'active',
      });
      await store.upsertClaudeEgressClientCert({
        projectId,
        certPem: `cert-${index}`,
        keyPem: `key-${index}`,
        fingerprint256: String(index).repeat(64).slice(0, 64),
        expiresAt: new Date('2027-06-01T00:00:00.000Z'),
      });
    }
    const listed = await store.listClaudeEgressClientCerts();
    expect(listed.map((r) => r.projectId)).toEqual([projectA, projectB]);

    // Rotate the first project's cert — upsert replaces, never duplicates.
    await store.upsertClaudeEgressClientCert({
      projectId: projectA,
      certPem: 'cert-rotated',
      keyPem: 'key-rotated',
      fingerprint256: 'b'.repeat(64),
      expiresAt: new Date('2028-01-01T00:00:00.000Z'),
    });
    const after = await store.listClaudeEgressClientCerts();
    expect(after).toHaveLength(2);
    expect(after.find((r) => r.projectId === projectA)?.fingerprint256).toBe('b'.repeat(64));
  });

  it('deletes a client cert directly and via project cascade', async () => {
    const kept = randomUUID();
    const removed = randomUUID();
    for (const [index, projectId] of [kept, removed].entries()) {
      await store.upsertProject({
        id: projectId,
        owner: 'heey-global',
        repo: `verity-c-${index}`,
        containerName: `dev-c-${index}`,
        state: 'active',
      });
      await store.upsertClaudeEgressClientCert({
        projectId,
        certPem: `cert-${index}`,
        keyPem: `key-${index}`,
        fingerprint256: String(index).repeat(64).slice(0, 64),
        expiresAt: new Date('2027-06-01T00:00:00.000Z'),
      });
    }

    await store.deleteClaudeEgressClientCert(removed);
    await expect(store.getClaudeEgressClientCert(removed)).resolves.toBeUndefined();
    await expect(store.getClaudeEgressClientCert(kept)).resolves.toBeDefined();

    // Deleting the project cascades to its egress client cert row.
    await raw.db.deleteFrom('projects').where('id', '=', kept).execute();
    await expect(store.getClaudeEgressClientCert(kept)).resolves.toBeUndefined();
  });
});
