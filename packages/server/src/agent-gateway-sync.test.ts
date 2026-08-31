import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  startAgentGatewayControlServer,
  type AgentGatewayConfiguration,
  type AgentGatewayControlServer,
} from './agent-gateway-control.js';
import { startAgentGatewaySynchronizer } from './agent-gateway-sync.js';

const roots: string[] = [];
const servers: AgentGatewayControlServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('agent gateway configuration synchronizer', () => {
  it('persists a pending Codex rotation before acknowledging it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-agent-gateway-sync-'));
    roots.push(root);
    const socketPath = join(root, 'control.sock');
    const update = {
      sourceRevision: '1'.repeat(64),
      updatedRevision: '2'.repeat(64),
      authJson: '{"tokens":{"access_token":"rotated"}}',
    };
    let pending: typeof update | undefined = update;
    const order: string[] = [];
    const server = await startAgentGatewayControlServer({
      socketPath,
      configure: () => undefined,
      status: () => ({ ready: true, configured: true, claudePeerCount: 0 }),
      readCodexCredentialUpdate: () => pending,
      ackCodexCredentialUpdate: () => {
        order.push('ack');
        pending = undefined;
      },
    });
    servers.push(server);
    const synchronizer = startAgentGatewaySynchronizer({
      socketPath,
      reconcileIntervalMs: 60_000,
      onError: (error) => {
        throw error;
      },
      persistCodexCredentialUpdate: async (received) => {
        expect(received).toEqual(update);
        order.push('persist');
        return true;
      },
    });

    await synchronizer.updateAndWait(configuration('codex-report'));
    expect(order).toEqual(['persist', 'ack']);
    expect(pending).toBeUndefined();
    await synchronizer.close();
  });

  it('does not fail an update while the sidecar is unavailable and reconciles after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-agent-gateway-sync-'));
    roots.push(root);
    const socketPath = join(root, 'control.sock');
    const errors: unknown[] = [];
    const synchronizer = startAgentGatewaySynchronizer({
      socketPath,
      reconcileIntervalMs: 20,
      onError: (error) => errors.push(error),
    });
    const expected = configuration('revision-after-restart');

    expect(() => synchronizer.update(expected)).not.toThrow();
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));

    let received: AgentGatewayConfiguration | undefined;
    const server = await startAgentGatewayControlServer({
      socketPath,
      configure(value): void {
        received = value;
      },
      status: () => ({
        ready: true,
        configured: received !== undefined,
        ...(received === undefined ? {} : { revision: received.revision }),
        claudePeerCount: received?.claude.peerBindings.length ?? 0,
      }),
    });
    servers.push(server);

    await vi.waitFor(() => expect(received?.revision).toBe(expected.revision));
    await synchronizer.close();
  });

  it('coalesces updates received during an in-flight synchronization to the newest snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-agent-gateway-sync-'));
    roots.push(root);
    const socketPath = join(root, 'control.sock');
    const seen: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => (releaseFirst = resolve));
    let firstEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => (firstEntered = resolve));
    const server = await startAgentGatewayControlServer({
      socketPath,
      async configure(value): Promise<void> {
        seen.push(value.revision);
        if (value.revision === 'first') {
          firstEntered?.();
          await firstBlocked;
        }
      },
      status: () => ({ ready: true, configured: seen.length > 0, claudePeerCount: 0 }),
    });
    servers.push(server);
    const synchronizer = startAgentGatewaySynchronizer({
      socketPath,
      reconcileIntervalMs: 60_000,
      onError: (error) => {
        throw error;
      },
    });

    synchronizer.update(configuration('first'));
    await entered;
    synchronizer.update(configuration('stale-middle'));
    synchronizer.update(configuration('latest'));
    releaseFirst?.();

    await vi.waitFor(() => expect(seen).toEqual(['first', 'latest']));
    await synchronizer.close();
  });

  it('waits for a concurrent newer snapshot instead of confirming an older one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-agent-gateway-sync-'));
    roots.push(root);
    const socketPath = join(root, 'control.sock');
    const seen: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => (releaseFirst = resolve));
    let firstEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => (firstEntered = resolve));
    let releaseRevocation: (() => void) | undefined;
    const revocationBlocked = new Promise<void>((resolve) => (releaseRevocation = resolve));
    const server = await startAgentGatewayControlServer({
      socketPath,
      async configure(value): Promise<void> {
        seen.push(value.revision);
        if (value.revision === 'turn') {
          firstEntered?.();
          await firstBlocked;
        }
        if (value.revision === 'revocation') await revocationBlocked;
      },
      status: () => ({ ready: true, configured: seen.length > 0, claudePeerCount: 0 }),
    });
    servers.push(server);
    const synchronizer = startAgentGatewaySynchronizer({
      socketPath,
      reconcileIntervalMs: 60_000,
      onError: (error) => {
        throw error;
      },
    });

    const turnConfirmed = synchronizer.updateAndWait(configuration('turn'));
    let turnResolved = false;
    void turnConfirmed.then(() => {
      turnResolved = true;
    });
    await entered;
    const revocationConfirmed = synchronizer.updateAndWait(configuration('revocation'));
    releaseFirst?.();

    await vi.waitFor(() => expect(seen).toEqual(['turn', 'revocation']));
    expect(turnResolved).toBe(false);
    releaseRevocation?.();
    await expect(turnConfirmed).resolves.toBeUndefined();
    await expect(revocationConfirmed).resolves.toBeUndefined();
    await synchronizer.close();
  });

  it('rejects confirmed updates after close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-agent-gateway-sync-'));
    roots.push(root);
    const synchronizer = startAgentGatewaySynchronizer({
      socketPath: join(root, 'control.sock'),
      reconcileIntervalMs: 60_000,
      onError: () => undefined,
    });

    await synchronizer.close();

    await expect(synchronizer.updateAndWait(configuration('after-close'))).rejects.toThrow(
      /synchronizer closed/,
    );
  });
});

function configuration(revision: string): AgentGatewayConfiguration {
  return {
    revision,
    claude: {
      tls: { ca: 'ca', cert: 'cert', key: 'key' },
      peerBindings: [
        {
          projectId: 'project-1',
          fingerprint256:
            'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
        },
      ],
    },
  };
}
