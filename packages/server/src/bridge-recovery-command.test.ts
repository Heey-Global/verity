import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerCompat } from './self-update/compat.js';
import type { SignedReleaseChannel } from './self-update/release-channel.js';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  admit: vi.fn(),
  request: vi.fn(),
  deployment: vi.fn(),
  verify: vi.fn(),
  local: vi.fn(),
  events: [] as string[],
}));
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.exec }) };
});
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: async (path: string) => (path.startsWith('/mock/') ? path : actual.realpath(path)),
    lstat: async (path: string) =>
      path.startsWith('/mock/')
        ? { uid: 0, mode: 0o700, isDirectory: () => true, isFile: () => true }
        : actual.lstat(path),
    readFile: async (path: string, encoding: BufferEncoding) =>
      path === '/mock/verity-updater-control/token'
        ? 't'.repeat(64)
        : actual.readFile(path, encoding),
  };
});
vi.mock('./self-update/bridge-recovery-admission.js', () => ({ admitBridgeRecovery: mocks.admit }));
vi.mock('./self-update/managed-deployment.js', () => ({ readManagedDeployment: mocks.local }));
vi.mock('./self-update/updater-status.js', () => ({
  readUpdaterDeployment: mocks.deployment,
  requestUpdaterOperation: mocks.request,
}));
vi.mock('./self-update/release-channel-verify.js', () => ({
  createReleaseChannelVerifier: () => mocks.verify,
}));

import { parseRecoveryArgs, runBridgeRecoveryCommand } from './bridge-recovery-command.js';

const image = (char: string) =>
  `ghcr.io/heey-global/verity/verity-server@sha256:${char.repeat(64)}`;
const compatibility = (version: string, current: string, max: string): ServerCompat => ({
  serverVersion: version,
  schema: { min: '0097', current, max },
  runner: { min: 1, current: 1 },
  eventLog: { min: 1, current: 1 },
  gateway: { min: 1, current: 1 },
  updater: { min: 1, current: 1 },
});
const current = compatibility('0.15.1', '0097', '0097');
const bridge = compatibility('0.15.2', '0097', '0098');
const successor = compatibility('0.16.0', '0098', '0098');
function envelope(compat: ServerCompat, serverImage: string) {
  return JSON.stringify({
    payload: Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        channel: 'stable',
        version: compat.serverVersion,
        revision: 'a'.repeat(40),
        architecture: 'amd64',
        serverImage,
        agentSeedImage: null,
        compatibility: compat,
        publishedAt: '2026-09-19T00:00:00Z',
        generation: `stable-${compat.serverVersion}`,
      }),
    ).toString('base64'),
    signature: { kind: 'sigstore-bundle', bundle: Buffer.from('fixture').toString('base64') },
  });
}

let directory: string;
let args: string[];
const apply = () => [
  ...args,
  '--apply',
  '--expected-current',
  image('a'),
  '--expected-bridge',
  image('b'),
  '--deployment-id',
  'deployment-1',
  '--request-id',
  'recovery-1',
];
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.events.length = 0;
  vi.spyOn(process, 'geteuid').mockReturnValue(0);
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  directory = await mkdtemp(join(tmpdir(), 'verity-recovery-command-'));
  await writeFile(join(directory, 'bridge.json'), envelope(bridge, image('b')));
  await writeFile(join(directory, 'successor.json'), envelope(successor, image('c')));
  args = [
    '--bridge',
    join(directory, 'bridge.json'),
    '--successor',
    join(directory, 'successor.json'),
  ];
  const deployment = {
    managed: true,
    marker: { deploymentId: 'deployment-1' },
    spec: { image: image('a') },
  };
  mocks.deployment.mockResolvedValue(deployment);
  mocks.local.mockResolvedValue(deployment);
  mocks.verify.mockImplementation(async (release: SignedReleaseChannel) => {
    mocks.events.push(`verify:${release.metadata.version}`);
    return true;
  });
  mocks.admit.mockImplementation(async () => {
    mocks.events.push('admit');
    return {};
  });
  mocks.request.mockImplementation(async () => {
    mocks.events.push('request');
    return { phase: 'requested' };
  });
  mocks.exec.mockImplementation(async (_file: string, argv: string[]) => {
    expect(argv[0]).toBe('--host=unix:///var/run/docker.sock');
    const command = argv.slice(1);
    if (command[0] === 'volume')
      return {
        stdout: JSON.stringify([
          { Name: command[2], Driver: 'local', Mountpoint: `/mock/${command[2]}` },
        ]),
      };
    if (command[0] === 'inspect' && command[1] === '--type=container')
      return {
        stdout: JSON.stringify([
          {
            Id: 'running-server',
            Image: 'current-image-id',
            State: { Running: true },
            Config: { Image: image('a') },
          },
        ]),
      };
    if (command[0] === 'inspect' && command[1] === '--type=image')
      return {
        stdout: JSON.stringify([
          {
            Id: command[2] === image('a') ? 'current-image-id' : 'bridge-image-id',
            Architecture: 'amd64',
          },
        ]),
      };
    if (command[0] === 'exec') return { stdout: JSON.stringify(current) };
    if (command[0] === 'pull') {
      mocks.events.push('pull');
      return { stdout: '' };
    }
    if (command[0] === 'run') {
      mocks.events.push('probe');
      return { stdout: JSON.stringify(bridge) };
    }
    throw new Error('Unexpected Docker invocation');
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe('bridge recovery host command', () => {
  it('defaults to a checked plan without admitting or requesting an update', async () => {
    await runBridgeRecoveryCommand(args);
    expect(mocks.events).toEqual(['verify:0.15.2', 'verify:0.16.0', 'pull', 'probe']);
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('verifies both envelopes and probes the image before admission and the legacy API request', async () => {
    await runBridgeRecoveryCommand(apply());
    expect(mocks.events).toEqual([
      'verify:0.15.2',
      'verify:0.16.0',
      'pull',
      'probe',
      'admit',
      'request',
    ]);
    expect(mocks.admit).toHaveBeenCalledWith({
      root: '/mock/verity-managed-deployment',
      expectedDeploymentId: 'deployment-1',
      expectedImage: image('a'),
      targetDigest: image('b'),
      idempotencyKey: 'recovery-1',
    });
    expect(mocks.request).toHaveBeenCalledWith({
      socketPath: '/mock/verity-updater-control/updater.sock',
      token: 't'.repeat(64),
      targetDigest: image('b'),
      idempotencyKey: 'recovery-1',
    });
    const probeArgs = mocks.exec.mock.calls.find(
      (call) => (call[1] as string[])[1] === 'run',
    )![1] as string[];
    expect(probeArgs).toEqual(
      expect.arrayContaining([
        '--network',
        'none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--user=1000:1000',
        'bridge-image-id',
      ]),
    );
    expect(probeArgs).not.toContain('--volume');
  });

  it.each(['a', 'b'])('refuses a stale approved digest %s before admission', async (approved) => {
    await expect(
      runBridgeRecoveryCommand(apply().map((arg) => (arg === image(approved) ? image('d') : arg))),
    ).rejects.toThrow('explicitly approved');
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('does not pull or admit an image whose signature is rejected', async () => {
    mocks.verify.mockResolvedValue(false);
    await expect(runBridgeRecoveryCommand(apply())).rejects.toThrow(
      'signature verification failed',
    );
    expect(mocks.events).toEqual([]);
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('never calls the legacy API after a stale admission rejects', async () => {
    mocks.admit.mockRejectedValue(new Error('deployment changed'));
    await expect(runBridgeRecoveryCommand(apply())).rejects.toThrow('deployment changed');
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('requires root before reading deployment state', async () => {
    vi.mocked(process.geteuid!).mockReturnValue(1000);
    await expect(runBridgeRecoveryCommand(args)).rejects.toThrow('must run as root');
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.deployment).not.toHaveBeenCalled();
  });

  it.each([
    ['--apply'],
    ['--check', '--apply'],
    ['--bridge', 'another.json'],
    ['--unknown'],
    ['--request-id'],
  ])('rejects incomplete, conflicting, duplicate or unknown arguments %j', (...extra) => {
    expect(() => parseRecoveryArgs([...args, ...extra])).toThrow();
  });
});
