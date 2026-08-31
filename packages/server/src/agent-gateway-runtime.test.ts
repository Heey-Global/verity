import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configureAgentGateway } from './agent-gateway-control.js';
import {
  logCodexEgressRequestEnd,
  logClaudeEgressRequestEnd,
  startAgentGatewayRuntime,
  type AgentGatewayRuntime,
} from './agent-gateway-runtime.js';
import { AgentGatewaySpill } from './agent-gateway-spill.js';
import type { ClaudeEgressMtlsGatewayOptions } from './claude-egress-mtls.js';
import type { CodexEgressGatewayOptions } from './codex-egress-gateway.js';

const roots: string[] = [];
const runtimes: AgentGatewayRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('standalone agent gateway runtime', () => {
  it('serves health independently and reflects control-plane configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-agent-gateway-runtime-'));
    roots.push(root);
    const socketPath = join(root, 'control.sock');
    let gatewayOptions: ClaudeEgressMtlsGatewayOptions | undefined;
    let tokenVisibleDuringStart = false;
    const startClaudeGateway = vi.fn(async (options: ClaudeEgressMtlsGatewayOptions) => {
      gatewayOptions = options;
      tokenVisibleDuringStart = (await options.accessToken('one')) === 'shadow-token';
      return {
        port: 9443,
        reloadTls: vi.fn(),
        close: vi.fn(async () => undefined),
      };
    });
    const runtime = await startAgentGatewayRuntime(runtimeOptions(root, startClaudeGateway));
    runtimes.push(runtime);

    await expect(health(runtime.healthPort, 503)).resolves.toEqual({
      ready: true,
      configured: false,
      claudePeerCount: 0,
      credentialReady: false,
      listenerReady: false,
    });
    await configureAgentGateway(socketPath, {
      revision: 'snapshot-2',
      claude: {
        tls: { ca: 'ca', cert: 'cert', key: 'key' },
        peerBindings: [
          { projectId: 'one', fingerprint256: '1'.repeat(64) },
          { projectId: 'two', fingerprint256: '2'.repeat(64) },
        ],
        credential: { unsealKey: '6a'.repeat(32), accessToken: 'shadow-token' },
      },
    });

    await expect(health(runtime.healthPort)).resolves.toEqual({
      ready: true,
      configured: true,
      revision: 'snapshot-2',
      claudePeerCount: 2,
      credentialReady: true,
      listenerReady: true,
      claudePort: 9443,
    });
    expect(startClaudeGateway).toHaveBeenCalledOnce();
    expect(tokenVisibleDuringStart).toBe(true);
    await expect(gatewayOptions?.accessToken('one')).resolves.toBe('shadow-token');

    await configureAgentGateway(socketPath, {
      ...configuration('6a'.repeat(32)),
      revision: 'revoked',
      claude: {
        ...configuration('6a'.repeat(32)).claude,
        credential: { unsealKey: '6a'.repeat(32), accessToken: null },
      },
    });
    await expect(health(runtime.healthPort, 503)).resolves.toMatchObject({
      credentialReady: false,
      listenerReady: true,
    });
    await expect(gatewayOptions?.accessToken('one')).rejects.toThrow(
      'Claude egress has no OAuth token configured',
    );
  });

  it('rejects duplicate peer bindings without replacing the active snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-agent-gateway-runtime-'));
    roots.push(root);
    const socketPath = join(root, 'control.sock');
    const runtime = await startAgentGatewayRuntime(
      runtimeOptions(root, async () => ({
        port: 9443,
        reloadTls: vi.fn(),
        close: vi.fn(async () => undefined),
      })),
    );
    runtimes.push(runtime);
    const binding = { projectId: 'one', fingerprint256: '1'.repeat(64) };

    await expect(
      configureAgentGateway(socketPath, {
        revision: 'invalid',
        claude: {
          tls: { ca: 'ca', cert: 'cert', key: 'key' },
          peerBindings: [binding, { ...binding, projectId: 'two' }],
          credential: { unsealKey: '6a'.repeat(32), accessToken: 'shadow-token' },
        },
      }),
    ).rejects.toThrow('control request failed');
    await expect(health(runtime.healthPort, 503)).resolves.toMatchObject({ configured: false });
  });

  it('recovers the encrypted credential after a gateway-only restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-agent-gateway-runtime-'));
    roots.push(root);
    const key = '6a'.repeat(32);
    const first = await startAgentGatewayRuntime(
      runtimeOptions(root, async () => ({
        port: 9443,
        reloadTls: vi.fn(),
        close: vi.fn(async () => undefined),
      })),
    );
    await configureAgentGateway(join(root, 'control.sock'), configuration(key, 'recovered-token'));
    await first.close();

    let gatewayOptions: ClaudeEgressMtlsGatewayOptions | undefined;
    const startClaudeGateway = vi.fn(async (options: ClaudeEgressMtlsGatewayOptions) => {
      gatewayOptions = options;
      return {
        port: 9443,
        reloadTls: vi.fn(),
        close: vi.fn(async () => undefined),
      };
    });
    const second = await startAgentGatewayRuntime(runtimeOptions(root, startClaudeGateway));
    runtimes.push(second);
    await configureAgentGateway(join(root, 'control.sock'), configuration(key));

    await expect(gatewayOptions?.accessToken('one')).resolves.toBe('recovered-token');
    expect(second.status()).toMatchObject({ credentialReady: true, listenerReady: true });

    await configureAgentGateway(join(root, 'control.sock'), {
      revision: 'server-disabled-projection',
      claude: {
        tls: { ca: 'ca', cert: 'cert', key: 'key' },
        peerBindings: [{ projectId: 'one', fingerprint256: '1'.repeat(64) }],
      },
    });
    expect(second.status()).toMatchObject({ credentialReady: false, listenerReady: true });
    await expect(
      new AgentGatewaySpill(join(root, 'state', 'claude.enc')).unseal(key),
    ).resolves.toBeUndefined();
  });

  it('fails credential revocation closed when its TLS reload fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-agent-gateway-runtime-'));
    roots.push(root);
    let gatewayOptions: ClaudeEgressMtlsGatewayOptions | undefined;
    const reloadTls = vi.fn(() => {
      throw new Error('reload failed');
    });
    const runtime = await startAgentGatewayRuntime(
      runtimeOptions(root, async (options) => {
        gatewayOptions = options;
        return { port: 9443, reloadTls, close: vi.fn(async () => undefined) };
      }),
    );
    runtimes.push(runtime);
    const socketPath = join(root, 'control.sock');
    const key = '6a'.repeat(32);
    await configureAgentGateway(socketPath, configuration(key, 'active-token'));

    await expect(
      configureAgentGateway(socketPath, {
        ...configuration(key),
        revision: 'revoked',
        claude: {
          ...configuration(key).claude,
          credential: { unsealKey: key, accessToken: null },
        },
      }),
    ).rejects.toThrow('control request failed');
    await expect(gatewayOptions?.accessToken('one')).rejects.toThrow(
      'Claude egress has no OAuth token configured',
    );
    expect(runtime.status()).toMatchObject({ revision: 'snapshot', credentialReady: false });
    await expect(
      new AgentGatewaySpill(join(root, 'state', 'claude.enc')).unseal(key),
    ).resolves.toBeUndefined();
  });

  it('rolls back a newly persisted token when listener startup fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-agent-gateway-runtime-'));
    roots.push(root);
    const key = '6a'.repeat(32);
    const runtime = await startAgentGatewayRuntime(
      runtimeOptions(root, async () => {
        throw new Error('listener start failed');
      }),
    );
    runtimes.push(runtime);

    await expect(
      configureAgentGateway(join(root, 'control.sock'), configuration(key, 'rejected-token')),
    ).rejects.toThrow('control request failed');
    expect(runtime.status()).toMatchObject({
      configured: false,
      credentialReady: false,
      listenerReady: false,
    });
    await expect(
      new AgentGatewaySpill(join(root, 'state', 'claude.enc')).unseal(key),
    ).resolves.toBeUndefined();
  });

  it('gives the listener a denial observer so rejected egress leaves a trace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-agent-gateway-runtime-'));
    roots.push(root);
    let gatewayOptions: ClaudeEgressMtlsGatewayOptions | undefined;
    const runtime = await startAgentGatewayRuntime(
      runtimeOptions(root, async (options: ClaudeEgressMtlsGatewayOptions) => {
        gatewayOptions = options;
        return { port: 9443, reloadTls: vi.fn(), close: vi.fn(async () => undefined) };
      }),
    );
    runtimes.push(runtime);

    await configureAgentGateway(
      join(root, 'control.sock'),
      configuration('6a'.repeat(32), 'shadow-token'),
    );

    expect(gatewayOptions?.onRequestEnd).toBe(logClaudeEgressRequestEnd);
  });

  it('keeps the dormant Codex authority independent and recovers it from encrypted spill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-agent-gateway-runtime-'));
    roots.push(root);
    const key = '7b'.repeat(32);
    const codexReloadTls = vi.fn();
    const startCodexGateway = vi.fn(async (options: CodexEgressGatewayOptions) => {
      expect(options.listenerAuthority).toBe('verity-agent-gateway:9444');
      expect(options.tls).toMatchObject({
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.3',
      });
      return {
        port: 9444,
        reloadTls: codexReloadTls,
        close: vi.fn(async () => undefined),
      };
    });
    const first = await startAgentGatewayRuntime({
      ...runtimeOptions(root, async () => ({
        port: 9443,
        reloadTls: vi.fn(),
        close: vi.fn(async () => undefined),
      })),
      codexPort: 9444,
      codexListenerAuthority: 'verity-agent-gateway:9444',
      codexSpillPath: join(root, 'state', 'codex.enc'),
      startCodexGateway,
    });
    await configureAgentGateway(join(root, 'control.sock'), {
      ...configuration('6a'.repeat(32), 'claude-token'),
      codex: {
        credential: {
          unsealKey: key,
          sourceRevision: '1'.repeat(64),
          authJson: JSON.stringify({
            tokens: {
              access_token: 'codex-access',
              refresh_token: 'codex-refresh',
              account_id: 'account-1',
            },
          }),
        },
      },
    });

    const installedOptions = startCodexGateway.mock.calls.at(-1)?.[0];
    expect(installedOptions?.onRequestEnd).toBe(logCodexEgressRequestEnd);
    await expect(installedOptions?.credential()).resolves.toEqual({
      accessToken: 'codex-access',
      accountId: 'account-1',
    });
    expect(first.status()).toMatchObject({
      codexCredentialReady: true,
      codexListenerReady: true,
      codexPort: 9444,
    });
    await configureAgentGateway(join(root, 'control.sock'), {
      ...configuration('6a'.repeat(32), 'claude-token'),
      revision: 'rotated-codex',
      codex: {
        credential: {
          unsealKey: key,
          sourceRevision: '2'.repeat(64),
          authJson: JSON.stringify({
            tokens: {
              access_token: 'codex-access-2',
              refresh_token: 'codex-refresh-2',
              account_id: 'account-1',
            },
          }),
        },
      },
    });
    await expect(installedOptions?.credential()).resolves.toEqual({
      accessToken: 'codex-access-2',
      accountId: 'account-1',
    });
    expect(startCodexGateway).toHaveBeenCalledOnce();
    expect(codexReloadTls).toHaveBeenLastCalledWith(
      expect.objectContaining({
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.3',
      }),
    );
    await first.close();

    const second = await startAgentGatewayRuntime({
      ...runtimeOptions(root, async () => ({
        port: 9443,
        reloadTls: vi.fn(),
        close: vi.fn(async () => undefined),
      })),
      codexPort: 9444,
      codexListenerAuthority: 'verity-agent-gateway:9444',
      codexSpillPath: join(root, 'state', 'codex.enc'),
      startCodexGateway,
    });
    runtimes.push(second);
    await configureAgentGateway(join(root, 'control.sock'), {
      ...configuration('6a'.repeat(32), 'claude-token'),
      codex: { credential: { unsealKey: key, sourceRevision: '2'.repeat(64) } },
    });
    const recoveredOptions = startCodexGateway.mock.calls.at(-1)?.[0];
    await expect(recoveredOptions?.credential()).resolves.toEqual({
      accessToken: 'codex-access-2',
      accountId: 'account-1',
    });
  });

  it('reports healthy for a ready Codex-only configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-agent-gateway-runtime-'));
    roots.push(root);
    const runtime = await startAgentGatewayRuntime({
      ...runtimeOptions(root, async () => {
        throw new Error('revoked Claude must not start');
      }),
      codexPort: 9444,
      codexListenerAuthority: 'codex-gateway.internal:9444',
      startCodexGateway: async () => ({
        port: 9444,
        reloadTls: vi.fn(),
        close: vi.fn(async () => undefined),
      }),
    });
    runtimes.push(runtime);

    await configureAgentGateway(join(root, 'control.sock'), {
      ...configuration('6a'.repeat(32)),
      claude: {
        ...configuration('6a'.repeat(32)).claude,
        credential: { unsealKey: '6a'.repeat(32), accessToken: null },
      },
      codex: {
        credential: {
          unsealKey: '7b'.repeat(32),
          sourceRevision: '1'.repeat(64),
          authJson: JSON.stringify({
            tokens: {
              access_token: 'codex-access',
              refresh_token: 'codex-refresh',
              account_id: 'account-1',
            },
          }),
        },
      },
    });

    await expect(health(runtime.healthPort)).resolves.toMatchObject({
      credentialReady: false,
      listenerReady: false,
      codexCredentialReady: true,
      codexListenerReady: true,
    });
  });
});

describe('default Claude egress request log', () => {
  const event = {
    reason: 'policy-rejected',
    status: 403,
    method: 'POST',
    path: '/v1/messages',
    queryParams: ['beta'],
    bytesForwarded: 0,
    durationMs: 12,
    projectId: 'one',
  } as const;

  it('warns with exactly one tagged JSON line for a failure', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      logClaudeEgressRequestEnd({ outcome: 'rejected', ...event });
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        '{"event":"claude-egress","outcome":"rejected","reason":"policy-rejected",' +
          '"status":403,"method":"POST","path":"/v1/messages","queryParams":["beta"],' +
          '"bytesForwarded":0,"durationMs":12,"projectId":"one"}',
      );
      expect(log).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  // Ordinary traffic must not land in the warning stream, or the signal this
  // record exists for drowns in successful turns.
  it('sends a completed request to stdout instead', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      logClaudeEgressRequestEnd({ ...event, outcome: 'completed', reason: 'ok', status: 200 });
      expect(log).toHaveBeenCalledOnce();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});

describe('default Codex egress request log', () => {
  const event = {
    reason: 'policy-rejected',
    status: 403,
    method: 'POST',
    path: '/codex/responses',
    bytesForwarded: 0,
    durationMs: 12,
    projectId: 'one',
  } as const;

  it('warns on failures and logs completed or consumer-closed requests', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      logCodexEgressRequestEnd({ outcome: 'rejected', ...event });
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        '{"event":"codex-egress","outcome":"rejected","reason":"policy-rejected",' +
          '"status":403,"method":"POST","path":"/codex/responses","bytesForwarded":0,' +
          '"durationMs":12,"projectId":"one"}',
      );
      logCodexEgressRequestEnd({ ...event, outcome: 'completed', reason: 'ok', status: 200 });
      expect(log).toHaveBeenCalledOnce();
      logCodexEgressRequestEnd({
        ...event,
        outcome: 'consumer-closed',
        reason: 'downstream-closed',
        status: 200,
        bytesForwarded: 42,
      });
      expect(log).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});

function configuration(unsealKey: string, accessToken?: string) {
  return {
    revision: 'snapshot',
    claude: {
      tls: { ca: 'ca', cert: 'cert', key: 'key' },
      peerBindings: [{ projectId: 'one', fingerprint256: '1'.repeat(64) }],
      credential: { unsealKey, ...(accessToken === undefined ? {} : { accessToken }) },
    },
  };
}

function runtimeOptions(
  root: string,
  startClaudeGateway: NonNullable<
    Parameters<typeof startAgentGatewayRuntime>[0]['startClaudeGateway']
  >,
): Parameters<typeof startAgentGatewayRuntime>[0] {
  return {
    controlSocketPath: join(root, 'control.sock'),
    healthPort: 0,
    claudePort: 9443,
    claudeListenerAuthority: 'verity-agent-gateway:9443',
    spillPath: join(root, 'state', 'claude.enc'),
    startClaudeGateway,
  };
}

async function health(port: number, expectedStatus = 200): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
  expect(response.status).toBe(expectedStatus);
  return response.json();
}
