import { createHash, randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { describe, expect, it } from 'vitest';
import { coreDataAssociation, coreDataAssociationSchema } from './core-data-association.js';
import { coreRecordingSummary } from './coordinated-recording-schema.js';
import { RemoteReturnPathDiagnostics } from './remote-return-path-diagnostics.js';
import { ReturnPathActivation } from './remote-return-path-activation.js';
import type { RemoteConnectorReservation } from './uplink-control-client.js';
import { createRemoteConnectorPool } from './remote-control-connector.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
const at = '2026-10-23T12:00:00.000Z';
const observation = (socket?: unknown, id: string | null = randomUUID()) =>
  coreDataAssociation('private-session', 'private-request', id, 'after_socket_creation', at, {
    _socket: socket,
  } as unknown as WebSocket);

describe('Core DATA association', () => {
  it('exports only direct numeric endpoints and explicit provenance without inferred joins', () => {
    const result = observation({
      localAddress: '127.0.0.1',
      localPort: 1234,
      remoteAddress: '2001:db8::1',
      remotePort: 443,
      token: 'private-token',
      url: 'private-url',
    });
    expect(coreDataAssociationSchema.parse(result)).toMatchObject({
      processBootId: expect.any(String),
      socketLifetimeId: expect.any(String),
      bindingSource: 'authenticated_control_session_request',
      session: hash('private-session'),
      request: hash('private-request'),
      activatedAt: at,
      coverageStart: 'after_socket_creation',
      socketEndpoints: {
        local: { address: '127.0.0.1', port: 1234 },
        remote: { address: '2001:db8::1', port: 443 },
      },
      uplinkConnectionId: null,
      natAssociation: 'unknown',
      envoyAssociation: 'unknown',
    });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(result.processBootId).toBe(observation().processBootId);
  });
  it('preserves missing, invalid and throwing runtime observations as unknown', () => {
    const throwing = Object.defineProperty({}, 'localAddress', {
      get() {
        throw new Error('secret');
      },
    });
    for (const socket of [
      undefined,
      throwing,
      { localAddress: 'https://private', localPort: 80 },
      { remoteAddress: '127.0.0.1', remotePort: 65536 },
    ]) {
      expect(observation(socket, null)).toMatchObject({
        socketLifetimeId: null,
        socketEndpoints: { local: null, remote: null },
      });
    }
    expect(() =>
      coreDataAssociation(
        'session',
        'request',
        null,
        'before_socket_creation',
        at,
        Object.defineProperty({}, '_socket', {
          get() {
            throw new Error('secret');
          },
        }) as WebSocket,
      ),
    ).not.toThrow();
  });
  it('preserves the association through support projection and rejects fabricated Uplink joins', () => {
    const summary = new RemoteReturnPathDiagnostics('private-session').exportSummary()!;
    summary.association = observation();
    expect(coreRecordingSummary.parse(summary).association).toEqual(summary.association);
    expect(
      coreRecordingSummary.safeParse({
        ...summary,
        association: { ...observation(), session: hash('foreign-session') },
      }).success,
    ).toBe(false);
    expect(
      coreRecordingSummary.safeParse({
        ...summary,
        association: {
          ...observation(),
          uplinkConnectionId: randomUUID(),
        },
      }).success,
    ).toBe(false);
  });
});

describe('runtime exact-session consent', () => {
  it('selects a known hash synchronously, never widens or renews on conflicting selection', async () => {
    const consent = new ReturnPathActivation(() => ({ enabled: true, installationId: 'paired' }));
    const pool = createRemoteConnectorPool({
      dataUrl: 'wss://example.test/data',
      localHost: '127.0.0.1',
      localPort: 443,
      returnPathExpiry: (sessionHash, connectorId) => consent.expiry(sessionHash, connectorId),
      returnPathSubscribe: (listener) => consent.subscribe(listener),
      onReturnPathSnapshot: () => {},
    });
    const reservations: RemoteConnectorReservation[] = [];
    try {
      const reserve = async (sessionId: string) => {
        const result = await pool.reserve(
          { sessionId, requestId: 'request', decisionExpiresAt: Date.now() + 1000 },
          new AbortController().signal,
        );
        if (typeof result === 'string') throw new Error(result);
        reservations.push(result);
        return result;
      };
      await reserve('foreign');
      await reserve('selected');
      expect(pool.diagnosticConnectorCount()).toBe(0);
      const expiry = new Date(Date.now() + 60_000).toISOString();
      expect(
        consent.start(expiry, hash('selected'), reservations[1]!.diagnosticId).sessionHash,
      ).toBe(hash('selected'));
      expect(pool.diagnosticConnectorCount()).toBe(1);
      expect(() => consent.start(expiry)).toThrow('already_active');
      expect(() => consent.start(expiry, hash('foreign'))).toThrow('already_active');
      await reserve('reconnected');
      expect(pool.diagnosticConnectorCount()).toBe(1);
      reservations[1]!.release('reconnect');
      await reserve('selected');
      expect(pool.diagnosticConnectorCount()).toBe(0);
      consent.stop();
      expect(pool.diagnosticConnectorCount()).toBe(0);
      expect(consent.status().sessionHash).toBeUndefined();
      expect(consent.expiry(hash('selected'))).toBeUndefined();
    } finally {
      for (const item of reservations) item.release('test');
      pool.disposeDiagnostics();
      consent.dispose();
    }
  });
  it('rejects malformed selectors before mutating consent', () => {
    const consent = new ReturnPathActivation(() => ({ enabled: true, installationId: 'paired' }));
    try {
      for (const selector of ['', '*', 'A'.repeat(16), 'a'.repeat(17)])
        expect(() => consent.start(new Date(Date.now() + 1000).toISOString(), selector)).toThrow(
          'invalid_session',
        );
      expect(consent.status().enabled).toBe(false);
    } finally {
      consent.dispose();
    }
  });
});
