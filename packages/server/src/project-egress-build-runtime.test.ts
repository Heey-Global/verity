import { describe, expect, it, vi } from 'vitest';
import {
  createProtectedBuildRuntime,
  protectedBuildLaunch,
  type ProtectedBuildRuntimeIO,
  type ProtectedBuildRuntimeState,
} from './project-egress-build-runtime.js';
import type { ProtectedBuildRequest } from './project-egress-build.js';
import type { ProtectedBuildAnchor } from './project-egress-build-network.js';
const request: ProtectedBuildRequest = {
  projectId: 'project-a',
  attemptId: '11111111-1111-4111-8111-111111111111',
  snapshot: 'attempt-abc/verity-build-xyz',
  image: `verity-devc-repo:${'a'.repeat(12)}`,
  noCache: false,
};
const anchor: ProtectedBuildAnchor = {
  binding: {
    projectId: request.projectId,
    generation: request.attemptId,
    networkId: '1'.repeat(64),
    networkName: 'verity-build-a',
    bridge: 'vebaaaaaaaaaaaa',
  },
  attemptId: request.attemptId,
  containerId: '2'.repeat(64),
  endpointId: '3'.repeat(64),
  ipv4: '10.1.0.2',
  ipv6: 'fd00::2',
  mac: '02:00:00:00:00:03',
  pid: 42,
  namespacePath: '/var/run/docker/netns/abc',
  namespaceIdentity: 'net:[1234]',
};
function fixture() {
  const calls: string[] = [];
  let saved: ProtectedBuildRuntimeState | undefined;
  let ready = true,
    ended = false,
    failure = false;
  const io: ProtectedBuildRuntimeIO = {
    async ready() {
      return ready;
    },
    networks: {
      async create() {
        calls.push('create');
        return structuredClone(anchor);
      },
      async inspect(value) {
        calls.push('inspect');
        if (failure) throw new Error('replaced');
        return value;
      },
      async remove(_value, isEnded) {
        if (!(await isEnded())) throw new Error('running');
        calls.push('remove-network');
      },
    },
    async load() {
      return saved && structuredClone(saved);
    },
    async save(value) {
      saved = structuredClone(value);
      calls.push(value.launched ? 'save-launch' : 'save-prepare');
    },
    async prepareFiles() {
      calls.push('files');
    },
    async launch() {
      calls.push('launch');
    },
    async status() {
      return 'running';
    },
    async stop() {
      calls.push('stop');
    },
    async ended() {
      return ended;
    },
    async cleanup() {
      calls.push('cleanup');
    },
    authority: {
      async prepare() {
        calls.push('prepare-policy');
      },
      async renew() {
        calls.push('renew');
      },
      async deny() {
        calls.push('deny');
      },
      async release() {
        calls.push('release-policy');
      },
    },
  };
  return {
    io,
    calls,
    notReady() {
      ready = false;
    },
    ended() {
      ended = true;
    },
    replace() {
      failure = true;
    },
  };
}
describe('protected build fixed host runtime', () => {
  it('prepares no workload, then records launch intent before starting fixed supervisor', async () => {
    const f = fixture();
    const runtime = createProtectedBuildRuntime(f.io);
    await runtime.prepare(request);
    expect(f.calls).toEqual(['create', 'save-prepare', 'prepare-policy', 'files']);
    await runtime.renew(request);
    await runtime.start(request);
    expect(f.calls.indexOf('save-launch')).toBeLessThan(f.calls.indexOf('launch'));
  });
  it('does not allocate an anchor without real toolchain readiness', async () => {
    const f = fixture();
    f.notReady();
    await expect(createProtectedBuildRuntime(f.io).prepare(request)).rejects.toThrow('not ready');
    expect(f.calls).toEqual([]);
  });
  it('re-inspects attachment before renewal and launch', async () => {
    const f = fixture();
    const runtime = createProtectedBuildRuntime(f.io);
    await runtime.prepare(request);
    f.replace();
    await expect(runtime.renew(request)).rejects.toThrow('replaced');
    await expect(runtime.start(request)).rejects.toThrow('replaced');
    expect(f.calls).not.toContain('launch');
    expect(f.calls).not.toContain('renew');
  });
  it('denies before stopping and keeps state while cgroup end is unknown', async () => {
    const f = fixture();
    const runtime = createProtectedBuildRuntime(f.io);
    await runtime.prepare(request);
    await runtime.stop(request);
    expect(f.calls.slice(-2)).toEqual(['deny', 'stop']);
    await expect(runtime.remove(request)).rejects.toThrow('termination is unconfirmed');
    expect(f.calls).not.toContain('cleanup');
    f.ended();
    await runtime.remove(request);
    expect(f.calls.slice(-3)).toEqual(['release-policy', 'remove-network', 'cleanup']);
  });
  it('does not infer termination from missing state', async () => {
    expect(await createProtectedBuildRuntime(fixture().io).ended(request)).toBe(false);
  });
  it('rejects a changed replay', async () => {
    const f = fixture();
    const runtime = createProtectedBuildRuntime(f.io);
    await runtime.prepare(request);
    await expect(runtime.start({ ...request, noCache: true })).rejects.toThrow('changed');
  });
  it('build launch contains no repository command, image or snapshot path', () => {
    const plan = protectedBuildLaunch(request, anchor);
    expect(plan.args.slice(-3)).toEqual([
      '/usr/local/libexec/verity-buildkit/protected-build-attempt',
      'run',
      plan.descriptorId,
    ]);
    expect(plan.args).toContain(`--property=NetworkNamespacePath=${anchor.namespacePath}`);
    expect(plan.args).toContain('--slice=verity-buildkit.slice');
    expect(plan.args).toContain(
      '--property=TemporaryFileSystem=/run:rw,size=64M /var/lib/cni:rw,size=16M',
    );
    expect(
      plan.args.some((value) => value.includes(request.image) || value.includes(request.snapshot)),
    ).toBe(false);
    expect(() =>
      protectedBuildLaunch(request, { ...anchor, namespacePath: '/proc/1/ns/net' }),
    ).toThrow('identity mismatch');
  });
});

it('retains successful transient unit completion until explicit cleanup', () => {
  expect(protectedBuildLaunch(request, anchor).args).toContain('--property=RemainAfterExit=yes');
});

it.each([
  ['network', 'network_prepare_failed'],
  ['authority', 'authority_prepare_failed'],
  ['files', 'files_prepare_failed'],
] as const)(
  'identifies a failed %s preparation step without disclosing its cause',
  async (step, reason) => {
    const { io } = fixture();
    const failure = new Error('private daemon details');
    if (step === 'network')
      io.networks.create = async () => {
        throw failure;
      };
    if (step === 'authority')
      io.authority.prepare = async () => {
        throw failure;
      };
    if (step === 'files')
      io.prepareFiles = async () => {
        throw failure;
      };
    const caught = await createProtectedBuildRuntime(io)
      .prepare(request)
      .catch((error: unknown) => error);
    expect(caught).toMatchObject({ reason, cause: failure });
    expect((caught as Error).message).not.toContain('private daemon details');
  },
);

it('cleans a partially prepared network only after exact partial termination proof', async () => {
  const { io } = fixture();
  const endedPartial = vi.fn(async () => false);
  const removePartial = vi.fn(async () => {});
  io.endedPartial = endedPartial;
  io.removePartial = removePartial;
  const runtime = createProtectedBuildRuntime(io);
  await expect(runtime.remove(request)).rejects.toThrow('partial termination is unconfirmed');
  expect(removePartial).not.toHaveBeenCalled();
  endedPartial.mockResolvedValue(true);
  await runtime.remove(request);
  expect(removePartial).toHaveBeenCalledWith(request);
});

it('retries resource removal when final file cleanup fails after network removal', async () => {
  const f = fixture();
  const { io, calls } = f;
  const runtime = createProtectedBuildRuntime(io);
  await runtime.prepare(request);
  f.ended();
  const cleanup = vi
    .fn()
    .mockRejectedValueOnce(new Error('cleanup reply lost'))
    .mockResolvedValue(undefined);
  io.cleanup = cleanup;
  // The retry must know where the previous one stopped, without losing the cause.
  await expect(runtime.remove(request)).rejects.toMatchObject({
    stage: 'files.cleanup',
    cause: { message: 'cleanup reply lost' },
  });
  await runtime.remove(request);
  expect(calls.filter((call) => call === 'remove-network')).toHaveLength(2);
  expect(cleanup).toHaveBeenCalledTimes(2);
});
