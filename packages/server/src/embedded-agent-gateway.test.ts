import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmbeddedAgentGateway } from './embedded-agent-gateway.js';

const synchronizer = vi.hoisted(() => ({
  update: vi.fn(),
  updateAndWait: vi.fn(async (): Promise<void> => undefined),
  close: vi.fn(async (): Promise<void> => undefined),
}));
vi.mock('./agent-gateway-sync.js', () => ({
  startAgentGatewaySynchronizer: vi.fn(() => synchronizer),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function gateway() {
  const credentials = {
    getAccessToken: vi.fn(async (): Promise<string | undefined> => 'fresh-token'),
    persistCodexCredentialUpdate: vi.fn(async () => true),
  };
  const getClaudeCredentialSync = vi.fn(() => credentials);
  const onError = vi.fn();
  const result = createEmbeddedAgentGateway({
    config: {
      agentGatewayControlSocket: '/unused/control.sock',
      agentGatewayUnsealKey: 'test-key',
    },
    personalProviderCredentials: { persistCodexUpdate: vi.fn(async () => true) },
    getClaudeCredentialSync,
    onError,
  });
  return { ...result, credentials, getClaudeCredentialSync, onError };
}

beforeEach(() => vi.clearAllMocks());

describe('embedded Agent Gateway foundation', () => {
  it('defers credential and logger access until their owning bootstrap stages exist', () => {
    const instance = gateway();
    expect(instance.getClaudeCredentialSync).not.toHaveBeenCalled();
    expect(instance.onError).not.toHaveBeenCalled();
    expect(instance.agentGatewayConfiguration()).toBeUndefined();
    instance.syncAgentGateway();
    expect(synchronizer.update).not.toHaveBeenCalled();
  });

  it('keeps unresolved credentials distinct from explicit revocation and a fresh login', () => {
    const instance = gateway();
    instance.state.tls = { ca: 'ca', cert: 'cert', key: 'key' };
    const pending = instance.agentGatewayConfiguration()!;
    expect(pending.claude.credential).toEqual({ unsealKey: 'test-key' });
    expect(pending.codex).toBeUndefined();
    instance.state.accessToken = null;
    instance.state.codexAuthJson = null;
    const revoked = instance.agentGatewayConfiguration()!;
    expect(revoked.claude.credential?.accessToken).toBeNull();
    expect(revoked.codex?.credential.authJson).toBeNull();
    instance.state.accessToken = 'fresh-token';
    instance.state.codexAuthJson = '{"tokens":{}}';
    const fresh = instance.agentGatewayConfiguration()!;
    expect(fresh.claude.credential?.accessToken).toBe('fresh-token');
    expect(fresh.codex?.credential.authJson).toBe('{"tokens":{}}');
    expect(new Set([pending.revision, revoked.revision, fresh.revision]).size).toBe(3);
  });

  it('normalizes binding order in revisions while retaining changes to personal logins', () => {
    const instance = gateway();
    instance.state.tls = { ca: 'ca', cert: 'cert', key: 'key' };
    instance.state.bindings = [
      { projectId: 'one', fingerprint256: 'first' },
      { projectId: 'two', userId: 'person', fingerprint256: 'second' },
    ];
    const original = instance.agentGatewayConfiguration()!;
    instance.state.bindings = [...instance.state.bindings].reverse();
    expect(instance.agentGatewayConfiguration()!.revision).toBe(original.revision);
    instance.state.people = [{ userId: 'person', claude: { accessToken: 'personal-token' } }];
    const changed = instance.agentGatewayConfiguration()!;
    expect(changed.revision).not.toBe(original.revision);
    expect(changed.personal?.people).toEqual(instance.state.people);
  });

  it('retries a turn snapshot if a binding changes during credential resolution', async () => {
    const instance = gateway();
    instance.state.tls = { ca: 'ca', cert: 'cert', key: 'key' };
    const first = deferred<string | undefined>();
    instance.credentials.getAccessToken.mockReturnValueOnce(first.promise);
    const turn = instance.synchronizeAgentGatewayForTurn();
    await vi.waitFor(() => expect(instance.credentials.getAccessToken).toHaveBeenCalledOnce());
    instance.state.bindingGeneration += 1;
    instance.state.bindings = [{ projectId: 'new', fingerprint256: 'current' }];
    first.resolve('stale-token');
    await turn;
    expect(instance.credentials.getAccessToken).toHaveBeenCalledTimes(2);
    expect(synchronizer.updateAndWait).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        claude: expect.objectContaining({
          peerBindings: instance.state.bindings,
          credential: { unsealKey: 'test-key', accessToken: 'fresh-token' },
        }),
      }),
    );
  });

  it('waits for the binding projection and gateway acknowledgement before starting a turn', async () => {
    const instance = gateway();
    instance.state.tls = { ca: 'ca', cert: 'cert', key: 'key' };
    const projection = deferred<void>();
    const acknowledgement = deferred<void>();
    instance.state.bindingProjection = projection.promise;
    synchronizer.updateAndWait.mockReturnValueOnce(acknowledgement.promise);
    let finished = false;
    const turn = instance.synchronizeAgentGatewayForTurn().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(instance.credentials.getAccessToken).not.toHaveBeenCalled();
    projection.resolve();
    await vi.waitFor(() => expect(synchronizer.updateAndWait).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    acknowledgement.resolve();
    await turn;
    expect(finished).toBe(true);
  });
});
