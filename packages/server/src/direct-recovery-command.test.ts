import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerCompat } from './self-update/compat.js';
import type { SignedReleaseChannel } from './self-update/release-channel.js';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  output: vi.fn(() => true),
  admit: vi.fn(),
  request: vi.fn(),
  deployment: vi.fn(),
  recoveryCapability: vi.fn(),
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
  readUpdaterRecoveryCapability: mocks.recoveryCapability,
  requestUpdaterOperation: mocks.request,
}));
vi.mock('./self-update/release-channel-verify.js', () => ({
  createReleaseChannelVerifier: () => mocks.verify,
}));

import { runDirectRecoveryCommand } from './direct-recovery-command.js';

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
const target = compatibility('0.16.0', '0098', '0098');
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
  '--expected-target',
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
  vi.spyOn(process.stdout, 'write').mockImplementation(mocks.output);
  directory = await mkdtemp(join(tmpdir(), 'verity-recovery-command-'));
  await writeFile(join(directory, 'target.json'), envelope(target, image('b')));
  await writeFile(join(directory, 'successor.json'), envelope(successor, image('c')));
  args = ['--target', join(directory, 'target.json'), '--updater-container', 'b'.repeat(64)];
  const deployment = {
    managed: true,
    marker: { deploymentId: 'deployment-1' },
    spec: { image: image('a') },
  };
  mocks.deployment.mockResolvedValue(deployment);
  mocks.recoveryCapability.mockResolvedValue(1);
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
    if (
      command[0] === 'inspect' &&
      command[1] === '--type=container' &&
      command[2] === 'b'.repeat(64)
    )
      return {
        stdout: JSON.stringify([
          {
            Id: 'b'.repeat(64),
            Image: 'target-image-id',
            State: { Running: true },
            Config: {
              Image: image('b'),
              Cmd: ['managed-updater'],
              Env: ['VERITY_MANAGED_DEPLOYMENT_ID=deployment-1'],
            },
            Mounts: [
              {
                Source: '/mock/verity-managed-deployment',
                Destination: '/var/lib/verity/updater/managed-deployment',
                RW: true,
              },
              {
                Source: '/mock/verity-updater-control',
                Destination: '/run/verity-updater/control',
                RW: true,
              },
            ],
          },
        ]),
      };
    if (command[0] === 'ps') return { stdout: `${'c'.repeat(64)}\n` };
    if (command[0] === 'inspect' && command[1] === '--format')
      return { stdout: '/verity-managed-server-g14\n' };
    if (command[0] === 'exec' && command[1] === 'b'.repeat(64)) return { stdout: '1' };
    if (command[0] === 'inspect' && command[1] === '--type=container')
      return {
        stdout: JSON.stringify([
          {
            Id: 'c'.repeat(64),
            Image: 'current-image-id',
            State: { Running: true },
            Config: {
              Image: image('a'),
              Labels: {
                'verity.managed-deployment-id': 'deployment-1',
                'verity.managed-role': 'server',
              },
            },
          },
        ]),
      };
    if (command[0] === 'inspect' && command[1] === '--type=image')
      return {
        stdout: JSON.stringify([
          {
            Id: command[2] === image('a') ? 'current-image-id' : 'target-image-id',
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
      return { stdout: JSON.stringify(target) };
    }
    throw new Error('Unexpected Docker invocation');
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe('direct recovery host command', () => {
  it('checks without creating update intent', async () => {
    await runDirectRecoveryCommand(args);
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('also accepts the initial managed Server name', async () => {
    const original = mocks.exec.getMockImplementation()! as (
      file: string,
      argv: string[],
    ) => Promise<{ stdout: string }>;
    mocks.exec.mockImplementation(async (file: string, argv: string[]) =>
      argv[1] === 'inspect' && argv[2] === '--format'
        ? { stdout: '/verity-managed-server\n' }
        : original(file, argv),
    );
    await runDirectRecoveryCommand(args);
    expect(mocks.output).toHaveBeenCalledWith(expect.stringContaining('"targetVersion": "0.16.0"'));
  });
  it('rejects ambiguous running managed Servers', async () => {
    const original = mocks.exec.getMockImplementation()! as (
      file: string,
      argv: string[],
    ) => Promise<{ stdout: string }>;
    mocks.exec.mockImplementation(async (file: string, argv: string[]) =>
      argv[1] === 'ps'
        ? { stdout: `${'c'.repeat(64)}\n${'d'.repeat(64)}\n` }
        : original(file, argv),
    );
    await expect(runDirectRecoveryCommand(args)).rejects.toThrow('exactly one');
    expect(mocks.admit).not.toHaveBeenCalled();
  });
  it('rejects a labelled Server with a malformed generation name', async () => {
    const original = mocks.exec.getMockImplementation()! as (
      file: string,
      argv: string[],
    ) => Promise<{ stdout: string }>;
    mocks.exec.mockImplementation(async (file: string, argv: string[]) =>
      argv[1] === 'inspect' && argv[2] === '--format'
        ? { stdout: '/verity-managed-server-g14-copy\n' }
        : original(file, argv),
    );
    await expect(runDirectRecoveryCommand(args)).rejects.toThrow('invalid identity');
    expect(mocks.admit).not.toHaveBeenCalled();
  });
  it('submits after signed image and new updater verification', async () => {
    await runDirectRecoveryCommand(apply());
    expect(mocks.events).toEqual(['verify:0.16.0', 'pull', 'probe', 'admit', 'request']);
  });
  it('rejects invalid signature before pulling or submitting', async () => {
    mocks.verify.mockResolvedValue(false);
    await expect(runDirectRecoveryCommand(apply())).rejects.toThrow('signature');
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('rejects signed metadata that differs from the actual image', async () => {
    const original = mocks.exec.getMockImplementation()! as (
      file: string,
      argv: string[],
    ) => Promise<{ stdout: string }>;
    mocks.exec.mockImplementation(async (file: string, argv: string[]) =>
      argv[1] === 'run' ? { stdout: JSON.stringify(current) } : original(file, argv),
    );
    await expect(runDirectRecoveryCommand(apply())).rejects.toThrow('signed compatibility');
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('rejects stale reviewed deployment', async () => {
    await expect(
      runDirectRecoveryCommand(apply().map((a) => (a === 'deployment-1' ? 'stale' : a))),
    ).rejects.toThrow('explicitly approved');
    expect(mocks.admit).not.toHaveBeenCalled();
  });
  it('prints a verified plan for a legacy updater without creating intent', async () => {
    const original = mocks.exec.getMockImplementation()! as (
      file: string,
      argv: string[],
    ) => Promise<{ stdout: string }>;
    mocks.exec.mockImplementation(async (file: string, argv: string[]) =>
      argv[1] === 'exec' && argv[2] === 'b'.repeat(64)
        ? { stdout: 'undefined' }
        : original(file, argv),
    );
    await runDirectRecoveryCommand(args);
    expect(mocks.output).toHaveBeenCalledWith(expect.stringContaining('"updaterReady": false'));
    expect(mocks.output).toHaveBeenCalledWith(expect.stringContaining(image('b')));
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('checks but refuses applying with the old updater image', async () => {
    const original = mocks.exec.getMockImplementation()! as (
      file: string,
      argv: string[],
    ) => Promise<{ stdout: string }>;
    mocks.exec.mockImplementation(async (file: string, argv: string[]) => {
      const result = await original(file, argv);
      if (argv[1] === 'inspect' && argv[2] === '--type=container' && argv[3] === 'b'.repeat(64))
        return { stdout: result.stdout.replaceAll(image('b'), image('a')) };
      return result;
    });
    await runDirectRecoveryCommand(args);
    expect(mocks.output).toHaveBeenCalledWith(expect.stringContaining('"updaterReady": false'));
    await expect(runDirectRecoveryCommand(apply())).rejects.toThrow(
      'Install the verified target Updater',
    );
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('refuses the legacy process still owning the control socket', async () => {
    mocks.recoveryCapability.mockRejectedValue(new Error('Updater HTTP 404'));
    await runDirectRecoveryCommand(args);
    expect(mocks.output).toHaveBeenCalledWith(expect.stringContaining('"updaterReady": false'));
    await expect(runDirectRecoveryCommand(apply())).rejects.toThrow('404');
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('never submits to a legacy updater without safety capability', async () => {
    const original = mocks.exec.getMockImplementation()! as (
      file: string,
      argv: string[],
    ) => Promise<{ stdout: string }>;
    mocks.exec.mockImplementation(async (file: string, argv: string[]) =>
      argv[1] === 'exec' && argv[2] === 'b'.repeat(64)
        ? { stdout: 'undefined' }
        : original(file, argv),
    );
    await expect(runDirectRecoveryCommand(apply())).rejects.toThrow('safety');
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('refuses a concurrent stale admission before requesting', async () => {
    mocks.admit.mockRejectedValue(
      new Error('deployment changed since bridge recovery verification'),
    );
    await expect(runDirectRecoveryCommand(apply())).rejects.toThrow('deployment changed');
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
