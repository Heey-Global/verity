import { describe, expect, it, vi } from 'vitest';
import { planBridgeRecovery } from './bridge-recovery.js';
import { SERVER_COMPAT, type ServerCompat } from './compat.js';

const digest = (character: string) =>
  `ghcr.io/heey-global/verity/verity-server@sha256:${character.repeat(64)}`;
const oldSchema = '0097_remove_cross_project_workflows';
const newSchema = '0098_google_workspace_files';
const current = {
  ...SERVER_COMPAT,
  serverVersion: '0.15.1',
  schema: { ...SERVER_COMPAT.schema, current: oldSchema, max: oldSchema },
};
const bridge = {
  ...current,
  serverVersion: '0.15.2',
  schema: { ...current.schema, max: newSchema },
};
const successor = {
  ...current,
  serverVersion: '0.16.0',
  schema: { ...current.schema, current: newSchema, max: newSchema },
};
function envelope(compatibility: ServerCompat, image: string, architecture = 'amd64') {
  return {
    payload: Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        channel: 'stable',
        version: compatibility.serverVersion,
        revision: 'a'.repeat(40),
        architecture,
        serverImage: image,
        agentSeedImage: null,
        compatibility,
        publishedAt: '2026-09-19T00:00:00Z',
        generation: `stable-${compatibility.serverVersion}`,
      }),
    ).toString('base64'),
    signature: { kind: 'sigstore-bundle', bundle: Buffer.from('{}').toString('base64') },
  };
}
function input() {
  return {
    current: {
      deploymentId: 'deployment',
      image: digest('a'),
      architecture: 'amd64' as const,
      compatibility: current,
    },
    bridge: envelope(bridge, digest('b')),
    successor: envelope(successor, digest('c')),
    verify: vi.fn(async () => true),
    inspectBridge: vi.fn(async () => ({ architecture: 'amd64' as const, compatibility: bridge })),
  };
}

describe('verified bridge recovery plan', () => {
  it('accepts a signed two-hop path below a previously advertised successor', async () => {
    const dependencies = input();
    const plan = await planBridgeRecovery(dependencies);
    expect(plan).toMatchObject({
      previousImage: digest('a'),
      bridgeImage: digest('b'),
      successorImage: digest('c'),
      bridgeVersion: '0.15.2',
    });
    expect(dependencies.verify).toHaveBeenCalledTimes(2);
    expect(dependencies.inspectBridge).toHaveBeenCalledExactlyOnceWith(digest('b'));
    expect(dependencies.verify.mock.invocationCallOrder[1]).toBeLessThan(
      dependencies.inspectBridge.mock.invocationCallOrder[0]!,
    );
  });

  it.each([0, 1])(
    'refuses an invalid signature on hop %s before pulling an image',
    async (index) => {
      const dependencies = input();
      dependencies.verify.mockImplementation(
        async () => dependencies.verify.mock.calls.length !== index + 1,
      );
      await expect(planBridgeRecovery(dependencies)).rejects.toThrow('signature');
      expect(dependencies.inspectBridge).not.toHaveBeenCalled();
    },
  );

  it('refuses malformed envelopes before verifying or pulling', async () => {
    const dependencies = input();
    await expect(planBridgeRecovery({ ...dependencies, bridge: {} })).rejects.toThrow('envelope');
    expect(dependencies.verify).not.toHaveBeenCalled();
    expect(dependencies.inspectBridge).not.toHaveBeenCalled();
  });

  it.each(['bridge', 'successor'] as const)('rejects the wrong architecture on %s', async (hop) => {
    const dependencies = input();
    dependencies[hop] = envelope(hop === 'bridge' ? bridge : successor, digest('b'), 'arm64');
    await expect(planBridgeRecovery(dependencies)).rejects.toThrow('architecture');
    expect(dependencies.inspectBridge).not.toHaveBeenCalled();
  });

  it.each([
    { ...bridge, serverVersion: '0.15.0' },
    { ...bridge, serverVersion: '0.15.1' },
    { ...bridge, serverVersion: '0.16.1' },
  ])('rejects a non-increasing bridge version $serverVersion', async (compatibility) => {
    const dependencies = input();
    dependencies.bridge = envelope(compatibility, digest('b'));
    await expect(planBridgeRecovery(dependencies)).rejects.toThrow('increasing');
  });

  it('rejects a bridge that already migrates beyond the running schema', async () => {
    const dependencies = input();
    dependencies.bridge = envelope({ ...bridge, schema: successor.schema }, digest('b'));
    await expect(planBridgeRecovery(dependencies)).rejects.toThrow('current schema');
  });

  it('rejects a bridge without its forward stamp', async () => {
    const dependencies = input();
    dependencies.bridge = envelope({ ...bridge, schema: current.schema }, digest('b'));
    await expect(planBridgeRecovery(dependencies)).rejects.toThrow('forward promise');
  });

  it('rejects a promise that does not reach the successor', async () => {
    const dependencies = input();
    dependencies.bridge = envelope(
      { ...bridge, schema: { ...bridge.schema, max: '0097_z_partial_promise' } },
      digest('b'),
    );
    await expect(planBridgeRecovery(dependencies)).rejects.toThrow('incompatible');
  });

  it('preserves protocol checks', async () => {
    const dependencies = input();
    dependencies.successor = envelope(
      {
        ...successor,
        runner: { min: current.runner.current + 1, current: current.runner.current + 1 },
      },
      digest('c'),
    );
    await expect(planBridgeRecovery(dependencies)).rejects.toThrow('runner protocol mismatch');
  });

  it('refuses an image whose contract differs from the signed document', async () => {
    const dependencies = input();
    dependencies.inspectBridge.mockResolvedValue({ architecture: 'amd64', compatibility: current });
    await expect(planBridgeRecovery(dependencies)).rejects.toThrow('signed compatibility');
  });
});
