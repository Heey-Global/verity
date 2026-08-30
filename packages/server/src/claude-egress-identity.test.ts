import { X509Certificate } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeEgressCaRecord, ClaudeEgressClientCertRecord } from '@verity/store';

import {
  createProjectEgressCa,
  issueGatewayServerCertificate,
  type EgressCa,
} from './claude-egress-ca.js';
import type { ClaudeEgressForward } from './claude-egress-gateway.js';
import {
  createClaudeEgressIdentityService,
  type ClaudeEgressIdentityStore,
} from './claude-egress-identity.js';
import { CLAUDE_EGRESS_PLACEHOLDER } from './claude-egress-policy.js';
import {
  startClaudeEgressMtlsGateway,
  type ClaudeEgressMtlsMaterial,
} from './claude-egress-mtls.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SERVER_NAME = 'localhost';
const AUTHORITY = 'claude-proxy.project-1:9443';

/** In-memory {@link ClaudeEgressIdentityStore}; counts CA writes so tests can
 *  assert lazy issue-once semantics. */
class FakeStore implements ClaudeEgressIdentityStore {
  ca: ClaudeEgressCaRecord | undefined;
  readonly clients = new Map<string, ClaudeEgressClientCertRecord>();
  caWrites = 0;
  failNextCaWrite = false;

  async getClaudeEgressCa(): Promise<ClaudeEgressCaRecord | undefined> {
    return this.ca;
  }
  async upsertClaudeEgressCa(record: ClaudeEgressCaRecord): Promise<void> {
    if (this.failNextCaWrite) {
      this.failNextCaWrite = false;
      throw new Error('CA store unavailable');
    }
    this.ca = record;
    this.caWrites += 1;
  }
  async replaceClaudeEgressCa(record: ClaudeEgressCaRecord): Promise<void> {
    this.ca = record;
    this.caWrites += 1;
    this.clients.clear();
  }
  async getClaudeEgressClientCert(
    projectId: string,
  ): Promise<ClaudeEgressClientCertRecord | undefined> {
    return this.clients.get(projectId);
  }
  async upsertClaudeEgressClientCert(record: ClaudeEgressClientCertRecord): Promise<void> {
    this.clients.set(record.projectId, record);
  }
  async listClaudeEgressClientCerts(): Promise<ClaudeEgressClientCertRecord[]> {
    return [...this.clients.values()].sort((a, b) => a.projectId.localeCompare(b.projectId));
  }
  async deleteClaudeEgressClientCert(projectId: string): Promise<void> {
    this.clients.delete(projectId);
  }
}

/** Seed a fresh CA row (far-future expiry) so a test that only exercises client
 *  issuance/rotation does not also trigger CA rotation. */
async function seedFreshCa(store: FakeStore): Promise<EgressCa> {
  const ca = await createProjectEgressCa({ validityDays: 3650 });
  const gateway = await issueGatewayServerCertificate(ca, { serverName: SERVER_NAME });
  store.ca = {
    caCertPem: ca.caCertPem,
    caKeyPem: ca.caKeyPem,
    gatewayServerName: SERVER_NAME,
    gatewayCertPem: gateway.certPem,
    gatewayKeyPem: gateway.keyPem,
    caExpiresAt: new Date(Date.now() + 3650 * DAY_MS),
    gatewayExpiresAt: new Date(Date.now() + 3650 * DAY_MS),
  };
  store.caWrites = 0;
  return ca;
}

const gateways: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
});

describe('Claude egress identity service', () => {
  it('mints the CA lazily once and reuses it across calls', async () => {
    const store = new FakeStore();
    const service = createClaudeEgressIdentityService({ store, serverName: SERVER_NAME });

    const first = await service.gatewayMaterial();
    await service.gatewayMaterial();

    expect(store.caWrites).toBe(1);
    expect(store.ca?.gatewayServerName).toBe(SERVER_NAME);
    expect(new X509Certificate(first.tls.cert as string).subjectAltName).toContain('localhost');
    expect(first.peerBindings).toEqual([]);
  });

  it('issues + persists a client cert and surfaces it in the gateway peer bindings', async () => {
    const store = new FakeStore();
    const service = createClaudeEgressIdentityService({ store, serverName: SERVER_NAME });

    const material = await service.sandboxMaterial('project-1');
    expect(material.projectId).toBe('project-1');
    const stored = store.clients.get('project-1');
    expect(stored).toBeDefined();
    expect(material.clientCertPem).toBe(stored?.certPem);

    const gateway = await service.gatewayMaterial();
    expect(gateway.peerBindings).toEqual([
      { projectId: 'project-1', fingerprint256: stored?.fingerprint256 },
    ]);
    // The CA was minted once and reused for the client cert.
    expect(store.caWrites).toBe(1);
  });

  it('re-issues a client cert once it is within the rotation window', async () => {
    const store = new FakeStore();
    await seedFreshCa(store);
    let nowMs = Date.parse('2026-05-01T00:00:00.000Z');
    const service = createClaudeEgressIdentityService({
      store,
      serverName: SERVER_NAME,
      rotateBeforeExpiryMs: 2 * DAY_MS,
      now: () => new Date(nowMs),
    });

    await service.sandboxMaterial('project-1');
    const firstFingerprint = store.clients.get('project-1')?.fingerprint256;
    // Force the stored cert to look near-expiry relative to the injected clock
    // (openssl stamps notAfter off the real wall clock, so drive freshness
    // through the record's expiresAt instead).
    const stored = store.clients.get('project-1');
    if (stored === undefined) throw new Error('expected a stored cert');
    store.clients.set('project-1', { ...stored, expiresAt: new Date(nowMs + DAY_MS) });

    const rotated = await service.sandboxMaterial('project-1');
    const secondFingerprint = store.clients.get('project-1')?.fingerprint256;
    expect(secondFingerprint).not.toBe(firstFingerprint);
    expect(rotated.clientCertPem).toBe(store.clients.get('project-1')?.certPem);

    // A still-fresh cert is reused, not reissued.
    nowMs += 1;
    await service.sandboxMaterial('project-1');
    expect(store.clients.get('project-1')?.fingerprint256).toBe(secondFingerprint);
  });

  it('rotates the CA when it is near expiry and drops stale client certs', async () => {
    const store = new FakeStore();
    await seedFreshCa(store);
    const staleCaCert = store.ca?.caCertPem;
    // Make the CA itself look near-expiry so the next call rotates it.
    if (store.ca === undefined) throw new Error('expected a seeded CA');
    store.ca = { ...store.ca, caExpiresAt: new Date(Date.now() + DAY_MS) };
    store.clients.set('orphan', {
      projectId: 'orphan',
      certPem: 'old',
      keyPem: 'old',
      fingerprint256: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 3650 * DAY_MS),
    });
    const onGatewayLeafChanged = vi.fn();
    const service = createClaudeEgressIdentityService({
      store,
      serverName: SERVER_NAME,
      rotateBeforeExpiryMs: 2 * DAY_MS,
      onGatewayLeafChanged,
    });

    await service.gatewayMaterial();

    expect(store.ca?.caCertPem).not.toBe(staleCaCert); // fresh CA minted
    expect(store.clients.size).toBe(0); // stale client certs dropped
    expect(onGatewayLeafChanged).toHaveBeenCalledOnce();
    expect(onGatewayLeafChanged).toHaveBeenCalledWith(
      expect.objectContaining({ ca: store.ca?.caCertPem, cert: store.ca?.gatewayCertPem }),
    );
  });

  it('refreshes only the gateway leaf when the server name changes, keeping client certs', async () => {
    const store = new FakeStore();
    await seedFreshCa(store);
    const originalCaCert = store.ca?.caCertPem;
    const originalGatewayCert = store.ca?.gatewayCertPem;
    // Pin a different server name so the CA is still fresh but its gateway leaf
    // must be re-issued.
    store.ca = store.ca ? { ...store.ca, gatewayServerName: 'stale-name' } : undefined;
    store.clients.set('project-1', {
      projectId: 'project-1',
      certPem: 'keep-cert',
      keyPem: 'keep-key',
      fingerprint256: 'c'.repeat(64),
      expiresAt: new Date(Date.now() + 3650 * DAY_MS),
    });
    const onGatewayLeafChanged = vi.fn();
    const service = createClaudeEgressIdentityService({
      store,
      serverName: SERVER_NAME,
      additionalServerNames: ['verity-agent-gateway'],
      onGatewayLeafChanged,
    });

    const material = await service.gatewayMaterial();

    expect(store.ca?.caCertPem).toBe(originalCaCert); // CA unchanged
    expect(store.ca?.gatewayServerName).toBe(`${SERVER_NAME},verity-agent-gateway`);
    expect(store.ca?.gatewayCertPem).not.toBe(originalGatewayCert); // gateway leaf re-issued
    expect(new X509Certificate(store.ca?.gatewayCertPem ?? '').subjectAltName).toContain(
      'localhost',
    );
    expect(new X509Certificate(store.ca?.gatewayCertPem ?? '').subjectAltName).toContain(
      'verity-agent-gateway',
    );
    // The still-valid client cert survives a gateway-only refresh.
    expect(store.clients.has('project-1')).toBe(true);
    expect(material.peerBindings).toEqual([
      { projectId: 'project-1', fingerprint256: 'c'.repeat(64) },
    ]);
    expect(onGatewayLeafChanged).toHaveBeenCalledOnce();
    expect(onGatewayLeafChanged).toHaveBeenCalledWith({
      ca: store.ca?.caCertPem,
      cert: store.ca?.gatewayCertPem,
      key: store.ca?.gatewayKeyPem,
    });
  });

  it('retries live TLS reconciliation after a persisted rotation callback fails', async () => {
    const store = new FakeStore();
    await seedFreshCa(store);
    store.ca = store.ca ? { ...store.ca, gatewayServerName: 'stale-name' } : undefined;
    const onGatewayLeafChanged = vi
      .fn<(material: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new Error('listener reload failed'))
      .mockResolvedValue(undefined);
    const service = createClaudeEgressIdentityService({
      store,
      serverName: SERVER_NAME,
      onGatewayLeafChanged,
    });

    await expect(service.gatewayMaterial()).rejects.toThrow('listener reload failed');
    const persistedBeforeRetry = store.ca?.gatewayCertPem;
    await expect(service.gatewayMaterial()).resolves.toBeDefined();

    expect(store.ca?.gatewayCertPem).not.toBe(persistedBeforeRetry);
    expect(onGatewayLeafChanged).toHaveBeenCalledTimes(2);
    expect(onGatewayLeafChanged.mock.calls[1]?.[0]).toMatchObject({
      cert: store.ca?.gatewayCertPem,
    });
  });

  it('rolls live gateway activation back when leaf persistence fails', async () => {
    const store = new FakeStore();
    await seedFreshCa(store);
    store.ca = store.ca ? { ...store.ca, gatewayServerName: 'stale-name' } : undefined;
    const original = store.ca;
    store.failNextCaWrite = true;
    const onGatewayLeafChanged = vi.fn(async (material: ClaudeEgressMtlsMaterial) => {
      void material;
    });
    const service = createClaudeEgressIdentityService({
      store,
      serverName: SERVER_NAME,
      onGatewayLeafChanged,
    });

    await expect(service.gatewayMaterial()).rejects.toThrow('CA store unavailable');
    expect(store.ca).toEqual(original);
    expect(onGatewayLeafChanged).toHaveBeenCalledTimes(2);
    expect(onGatewayLeafChanged.mock.calls[1]?.[0]).toMatchObject({
      ca: original?.caCertPem,
      cert: original?.gatewayCertPem,
      key: original?.gatewayKeyPem,
    });
  });

  it('serializes concurrent leaf rotation so listener and storage cannot diverge', async () => {
    const store = new FakeStore();
    await seedFreshCa(store);
    store.ca = store.ca ? { ...store.ca, gatewayServerName: 'stale-name' } : undefined;
    let enterCallback: (() => void) | undefined;
    const callbackEntered = new Promise<void>((resolve) => {
      enterCallback = resolve;
    });
    let releaseCallback: (() => void) | undefined;
    const callbackReleased = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    const onGatewayLeafChanged = vi.fn(async () => {
      enterCallback?.();
      await callbackReleased;
    });
    const service = createClaudeEgressIdentityService({
      store,
      serverName: SERVER_NAME,
      onGatewayLeafChanged,
    });

    const first = service.gatewayMaterial();
    const second = service.gatewayMaterial();
    await callbackEntered;
    expect(onGatewayLeafChanged).toHaveBeenCalledOnce();

    releaseCallback?.();
    const [firstMaterial, secondMaterial] = await Promise.all([first, second]);

    expect(onGatewayLeafChanged).toHaveBeenCalledOnce();
    expect(firstMaterial.tls.cert).toBe(store.ca?.gatewayCertPem);
    expect(secondMaterial.tls.cert).toBe(store.ca?.gatewayCertPem);
  });

  it('revokes a project by deleting its client cert', async () => {
    const store = new FakeStore();
    const service = createClaudeEgressIdentityService({ store, serverName: SERVER_NAME });
    await service.sandboxMaterial('project-1');
    expect(store.clients.has('project-1')).toBe(true);

    await service.revokeProject('project-1');
    expect(store.clients.has('project-1')).toBe(false);
  });

  it('serializes same-project issuance so concurrent callers share one leaf', async () => {
    const store = new FakeStore();
    await seedFreshCa(store);
    const upsert = vi.spyOn(store, 'upsertClaudeEgressClientCert');
    const service = createClaudeEgressIdentityService({ store, serverName: SERVER_NAME });

    const [first, second] = await Promise.all([
      service.sandboxMaterial('project-1'),
      service.sandboxMaterial('project-1'),
    ]);

    expect(upsert).toHaveBeenCalledOnce();
    expect(first.clientCertPem).toBe(second.clientCertPem);
  });

  it('orders same-project revocation after an in-flight issuance', async () => {
    const store = new FakeStore();
    await seedFreshCa(store);
    const service = createClaudeEgressIdentityService({ store, serverName: SERVER_NAME });

    const issuance = service.sandboxMaterial('project-1');
    const revocation = service.revokeProject('project-1');
    await Promise.all([issuance, revocation]);

    expect(store.clients.has('project-1')).toBe(false);
  });

  it('emits the current binding set to onBindingsChanged on issue and revoke', async () => {
    const store = new FakeStore();
    const emitted: Array<Array<{ projectId: string; fingerprint256: string }>> = [];
    const service = createClaudeEgressIdentityService({
      store,
      serverName: SERVER_NAME,
      onBindingsChanged: (bindings) => {
        emitted.push(bindings.map((b) => ({ ...b })));
      },
    });

    await service.sandboxMaterial('project-1');
    await service.sandboxMaterial('project-2');
    // A reuse (fresh cert already stored) must NOT re-emit.
    await service.sandboxMaterial('project-1');
    await service.revokeProject('project-1');

    // Two issues + one revoke → three emissions, each the full current set.
    expect(emitted).toHaveLength(3);
    expect(emitted[0]?.map((b) => b.projectId)).toEqual(['project-1']);
    expect(emitted[1]?.map((b) => b.projectId)).toEqual(['project-1', 'project-2']);
    expect(emitted[2]?.map((b) => b.projectId)).toEqual(['project-2']);
    // The emitted fingerprints match what the gateway peer registry needs.
    expect(emitted[1]?.find((b) => b.projectId === 'project-2')?.fingerprint256).toBe(
      store.clients.get('project-2')?.fingerprint256,
    );
  });

  it('serializes binding emissions so concurrent issues cannot interleave', async () => {
    const store = new FakeStore();
    await seedFreshCa(store);
    let active = 0;
    let maxActive = 0;
    let last: Array<{ projectId: string }> = [];
    const service = createClaudeEgressIdentityService({
      store,
      serverName: SERVER_NAME,
      onBindingsChanged: async (bindings) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        // Yield: a non-serialized implementation would let a second emit enter the
        // callback here, driving active to 2.
        await Promise.resolve();
        last = bindings.map((b) => ({ projectId: b.projectId }));
        active -= 1;
      },
    });

    await Promise.all([service.sandboxMaterial('project-1'), service.sandboxMaterial('project-2')]);

    expect(maxActive).toBe(1); // never two callbacks in flight at once
    // The last (serialized) emit observed the full, post-both-mutations set.
    expect(last.map((b) => b.projectId).sort()).toEqual(['project-1', 'project-2']);
  });

  it('produces gateway + sandbox material that authenticates end-to-end', async () => {
    const store = new FakeStore();
    const service = createClaudeEgressIdentityService({ store, serverName: SERVER_NAME });

    const sandbox = await service.sandboxMaterial('project-1');
    const material = await service.gatewayMaterial();

    const accessToken = vi.fn(async () => 'server-only-token');
    const forward = vi.fn<ClaudeEgressForward>(async (req) => {
      expect(req.headers.get('authorization')).toBe('Bearer server-only-token');
      return { status: 200, headers: {}, body: Readable.from(['ok']) };
    });
    const gateway = await startClaudeEgressMtlsGateway({
      projectId: 'project-1',
      listenerAuthority: AUTHORITY,
      accessToken,
      forward,
      peerBindings: material.peerBindings,
      tls: material.tls,
      port: 0,
    });
    gateways.push(gateway);

    const response = await call(
      gateway.port,
      sandbox.clientCertPem,
      sandbox.clientKeyPem,
      material,
    );
    expect(response).toEqual({ status: 200, body: 'ok' });
    expect(accessToken).toHaveBeenCalledWith('project-1');
  });
});

function call(
  port: number,
  clientCertPem: string,
  clientKeyPem: string,
  material: { tls: { ca?: string | Buffer | Array<string | Buffer> | undefined } },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        servername: SERVER_NAME,
        ca: material.tls.ca,
        cert: clientCertPem,
        key: clientKeyPem,
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        method: 'POST',
        path: '/v1/messages',
        headers: { host: AUTHORITY, authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}` },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (body += chunk));
        response.once('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    req.once('error', reject);
    req.end();
  });
}
