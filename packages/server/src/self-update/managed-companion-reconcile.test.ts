import {
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ContainerInspect, ContainerSpec, DockerClient } from '../docker.js';
import {
  reconcileManagedCompanions,
  publishAgentSeedAtomically,
  runManagedCompanionHandoff,
} from './managed-companion-reconcile.js';
import type { UpdateJournal } from './update-journal.js';

const oldImage = `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`;
const targetImage = `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`;
const journal = {
  deploymentId: 'deployment-1',
  generation: 7,
  targetDigest: targetImage,
} as UpdateJournal;
const shippedSeed = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../features/verity-sandbox-toolkit/agent-seed',
);

async function seedSource(root: string): Promise<string> {
  const source = join(root, 'source');
  await cp(shippedSeed, source, { recursive: true });
  return source;
}

const service = (
  id: string,
  name: string,
  role: string,
): { id: string; imageId: string; names: string[]; labels: Record<string, string> } => ({
  id,
  imageId: id,
  names: [name],
  labels: {
    'com.docker.compose.service': role,
    'com.docker.compose.project': 'verity',
  },
});

function fake(images: { gateway: string; updater: string }) {
  const gateway = service('a'.repeat(64), 'verity-gateway-1', 'verity-managed-gateway');
  const updater = service('b'.repeat(64), 'verity-updater-1', 'verity-updater');
  const agentGateway = service('d'.repeat(64), 'verity-agent-gateway-1', 'verity-agent-gateway');
  const summaries = [gateway, updater, agentGateway];
  const specs: ContainerSpec[] = [];
  const started: string[] = [];
  const removed: string[] = [];
  const replacements: Array<[string, string]> = [];
  const inspect = new Map<string, ContainerInspect>([
    [
      gateway.id,
      {
        id: gateway.id,
        running: true,
        image: images.gateway,
      },
    ],
    [
      agentGateway.id,
      {
        id: agentGateway.id,
        running: true,
        image: images.gateway,
      },
    ],
    [
      updater.id,
      {
        id: updater.id,
        running: true,
        image: images.updater,
        env: ['VERITY_MANAGED_DEPLOYMENT_ID=deployment-1'],
        mounts: [
          {
            type: 'bind',
            source: '/opt/agent-seed',
            destination: '/opt/agent-seed',
            readWrite: false,
          },
        ],
      },
    ],
  ]);
  const docker = {
    listContainers: vi.fn(async () => summaries),
    inspectContainer: vi.fn(async (id: string) => inspect.get(id)!),
    replaceContainerImage: vi.fn(async (id: string, image: string) => {
      replacements.push([id, image]);
      inspect.set(id, { id, running: true, image });
      return id;
    }),
    createContainer: vi.fn(async (spec: ContainerSpec) => {
      specs.push(spec);
      return { id: 'c'.repeat(64), warnings: [] };
    }),
    startContainer: vi.fn(async (id: string) => {
      started.push(id);
      const current = inspect.get(id);
      if (current !== undefined) inspect.set(id, { ...current, running: true });
    }),
    stopContainer: vi.fn(async () => undefined),
    removeContainer: vi.fn(async (id: string) => {
      removed.push(id);
    }),
    pullImage: vi.fn(async () => undefined),
    waitContainer: vi.fn(async () => 0),
  } satisfies Pick<
    DockerClient,
    | 'listContainers'
    | 'inspectContainer'
    | 'replaceContainerImage'
    | 'createContainer'
    | 'startContainer'
    | 'stopContainer'
    | 'removeContainer'
    | 'pullImage'
    | 'waitContainer'
  >;
  return { docker, inspect, summaries, specs, started, removed, replacements };
}

/**
 * A daemon client that never had a capability — the key ABSENT, not present with
 * an `undefined` value. The guards under test read `=== undefined`, but that is
 * a shape `exactOptionalPropertyTypes` refuses to let an optional method be
 * written as, and one a real client cannot have either.
 */
function withoutCapability<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const rest = { ...value } as Record<PropertyKey, unknown>;
  delete rest[key];
  return rest as unknown as Omit<T, K>;
}

describe('managed companion reconciliation', () => {
  it('publishes a complete seed from missing and interrupted directory states', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-agent-seed-'));
    const source = await seedSource(root);
    const target = join(root, 'seed');
    await writeFile(join(source, 'bin', 'verity-git-sign'), 'new wrapper', { mode: 0o755 });

    await publishAgentSeedAtomically(
      source,
      target,
      targetImage,
      '13.1.5',
      () => new Date('2026-08-14T00:00:00Z'),
    );
    expect(await readFile(join(target, '.current', 'bin', 'verity-git-sign'), 'utf8')).toBe(
      'new wrapper',
    );
    expect(await readFile(join(target, '.current', '.verity-agent-seed'), 'utf8')).toContain(
      `image=${targetImage}`,
    );
    const mountedRoot = (await stat(target)).ino;

    await writeFile(join(source, 'bin', 'verity-git-sign'), 'newer wrapper', { mode: 0o755 });
    await writeFile(join(target, 'retired-wrapper'), 'stale');
    await publishAgentSeedAtomically(source, target, oldImage, '13.1.6');
    expect(await readFile(join(target, '.current', 'bin', 'verity-git-sign'), 'utf8')).toBe(
      'newer wrapper',
    );
    expect((await stat(target)).ino).toBe(mountedRoot);
    expect(await readFile(join(target, 'retired-wrapper'), 'utf8')).toBe('stale');
  });

  it('hands the old Updater off only after replacing the stable Gateway', async () => {
    const state = fake({ gateway: oldImage, updater: oldImage });
    const handoff = new Error('handoff started');

    await expect(
      reconcileManagedCompanions({
        managedRoot: '/managed',
        docker: state.docker,
        journal,
        waitForHandoff: async () => {
          throw handoff;
        },
      }),
    ).rejects.toBe(handoff);

    expect(state.replacements).toEqual([
      ['d'.repeat(64), targetImage],
      ['a'.repeat(64), targetImage],
    ]);
    expect(state.specs).toHaveLength(1);
    expect(state.specs[0]).toMatchObject({
      image: targetImage,
      name: 'verity-managed-companion-handoff-g7',
      command: ['managed-companion-handoff'],
      network: 'none',
      restartPolicy: 'on-failure',
    });
    expect(state.started).toEqual(['c'.repeat(64)]);
  });

  it('lets the successor Updater reconcile the Runner and finish', async () => {
    const state = fake({ gateway: targetImage, updater: targetImage });
    const reconcileRunner = vi.fn(async () => undefined);

    await reconcileManagedCompanions({
      managedRoot: '/managed',
      docker: state.docker,
      journal,
      reconcileRunner,
    });

    expect(state.replacements).toEqual([]);
    expect(state.specs).toEqual([]);
    expect(reconcileRunner).toHaveBeenCalledOnce();
  });

  it('restarts a stopped target-image Gateway before completing', async () => {
    const state = fake({ gateway: targetImage, updater: targetImage });
    const gatewayId = 'a'.repeat(64);
    state.inspect.set(gatewayId, {
      ...state.inspect.get(gatewayId)!,
      running: false,
    });

    await reconcileManagedCompanions({
      managedRoot: '/managed',
      docker: state.docker,
      journal,
      reconcileRunner: () => Promise.resolve(),
    });

    expect(state.started).toContain(gatewayId);
  });

  it('waits for a target-image Agent Gateway health transition', async () => {
    const state = fake({ gateway: targetImage, updater: targetImage });
    const agentId = 'd'.repeat(64);
    let agentReads = 0;
    state.docker.inspectContainer.mockImplementation(async (id: string) => {
      const current = state.inspect.get(id)!;
      if (id !== agentId) return current;
      agentReads += 1;
      return {
        ...current,
        healthStatus: agentReads < 3 ? 'starting' : 'healthy',
      };
    });

    await reconcileManagedCompanions({
      managedRoot: '/managed',
      docker: state.docker,
      journal,
      reconcileRunner: () => Promise.resolve(),
    });

    expect(agentReads).toBeGreaterThanOrEqual(3);
  });

  it('waits out a slow start instead of rolling a healthy replacement back', async () => {
    // The Gateways carry `start period 10s, interval 10s, retries 5`, so a loaded
    // host legitimately leaves one in `starting` for about a minute. The previous
    // ceiling was 30s — two probes — and gave up while the container's own verdict
    // was still pending, which stranded the update at `reconciling-companions`.
    const state = fake({ gateway: targetImage, updater: targetImage });
    const agentId = 'd'.repeat(64);
    let agentReads = 0;
    state.docker.inspectContainer.mockImplementation(async (id: string) => {
      const current = state.inspect.get(id)!;
      if (id !== agentId) return current;
      agentReads += 1;
      // Healthy only well beyond the old 60-sample ceiling.
      return { ...current, healthStatus: agentReads < 90 ? 'starting' : 'healthy' };
    });

    await reconcileManagedCompanions({
      managedRoot: '/managed',
      docker: state.docker,
      journal,
      reconcileRunner: () => Promise.resolve(),
      sleep: async () => undefined,
    });

    expect(agentReads).toBeGreaterThanOrEqual(90);
  });

  it('still gives up on a container that never settles', async () => {
    const state = fake({ gateway: targetImage, updater: targetImage });
    const agentId = 'd'.repeat(64);
    state.docker.inspectContainer.mockImplementation(async (id: string) => {
      const current = state.inspect.get(id)!;
      return id === agentId ? { ...current, healthStatus: 'starting' } : current;
    });

    await expect(
      reconcileManagedCompanions({
        managedRoot: '/managed',
        docker: state.docker,
        journal,
        reconcileRunner: () => Promise.resolve(),
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(/did not become healthy/);
  });

  it('resumes replacement while predecessor and prepared successor both exist', async () => {
    const state = fake({ gateway: oldImage, updater: targetImage });
    const predecessor = 'a'.repeat(64);
    const successor = service(
      '9'.repeat(64),
      'verity-gateway-1-replacement',
      'verity-managed-gateway',
    );
    successor.labels['verity.replacement-for'] = predecessor;
    successor.labels['verity.replacement-name'] = 'verity-gateway-1';
    state.summaries.push(successor);
    state.inspect.set(successor.id, { id: successor.id, image: targetImage, running: false });

    await reconcileManagedCompanions({
      managedRoot: '/managed',
      docker: state.docker,
      journal,
      reconcileRunner: () => Promise.resolve(),
    });

    expect(state.replacements).toContainEqual([predecessor, targetImage]);
  });

  it('restarts a failed handoff without touching another deployment', async () => {
    const state = fake({ gateway: targetImage, updater: oldImage });
    const failed = {
      id: 'e'.repeat(64),
      imageId: 'e'.repeat(64),
      names: ['verity-managed-companion-handoff-g7'],
      labels: {
        'verity.managed-deployment-id': 'deployment-1',
        'verity.managed-role': 'companion-handoff',
      },
    };
    const foreign = {
      ...failed,
      id: 'f'.repeat(64),
      labels: { ...failed.labels, 'verity.managed-deployment-id': 'deployment-2' },
    };
    state.summaries.push(failed, foreign);
    state.inspect.set(failed.id, { id: failed.id, image: targetImage, running: false });
    state.inspect.set(foreign.id, { id: foreign.id, image: targetImage, running: true });
    const handoff = new Error('handoff restarted');

    await expect(
      reconcileManagedCompanions({
        managedRoot: '/managed',
        docker: state.docker,
        journal,
        waitForHandoff: async () => {
          throw handoff;
        },
      }),
    ).rejects.toBe(handoff);

    expect(state.removed).toContain(failed.id);
    expect(state.removed).not.toContain(foreign.id);
    expect(state.specs).toHaveLength(1);
  });

  it('uses the target-image helper to replace the old Updater exactly once', async () => {
    const replace = vi.fn(async () => 'successor-id');
    await runManagedCompanionHandoff(
      { replaceContainerImage: replace },
      {
        VERITY_HANDOFF_UPDATER_ID: 'a'.repeat(64),
        VERITY_HANDOFF_TARGET_IMAGE: targetImage,
        VERITY_HANDOFF_DEPLOYMENT_ID: 'deployment-1',
        VERITY_HANDOFF_AGENT_SEED_TARGET: '/opt/agent-seed-host-parent/agent-seed',
      },
      { publishAgentSeed: async () => undefined },
    );
    expect(replace).toHaveBeenCalledWith('a'.repeat(64), targetImage);
  });

  /**
   * The handoff helper runs as root with the daemon socket bound in, and every
   * instruction it acts on arrives as an environment variable. Each refusal below
   * names a different way that instruction could have come from somewhere other
   * than the Updater that wrote it — a distinct verdict matters, because "the
   * handoff did not run" is otherwise indistinguishable from "the handoff ran
   * against the wrong container".
   */
  it.each([
    [
      'an Updater id that is not a container id',
      { VERITY_HANDOFF_UPDATER_ID: 'not-a-container' },
      'companion handoff requires a valid Updater container id',
    ],
    [
      'a target image from outside the official repository',
      { VERITY_HANDOFF_TARGET_IMAGE: `ghcr.io/attacker/verity-server@sha256:${'b'.repeat(64)}` },
      'companion handoff requires an official digest-pinned target image',
    ],
    [
      'a target image pinned by tag rather than digest',
      { VERITY_HANDOFF_TARGET_IMAGE: 'ghcr.io/heey-global/verity/verity-server:13.4.1' },
      'companion handoff requires an official digest-pinned target image',
    ],
    [
      'a deployment id that could traverse out of its namespace',
      { VERITY_HANDOFF_DEPLOYMENT_ID: '../deployment-2' },
      'companion handoff requires a valid deployment id',
    ],
    [
      'a seed target outside the one parent the bind mount covers',
      { VERITY_HANDOFF_AGENT_SEED_TARGET: '/opt/somewhere-else/agent-seed' },
      'companion handoff requires an agent-seed target in the fixed parent',
    ],
    [
      'a seed target whose name is a shell-hostile path segment',
      { VERITY_HANDOFF_AGENT_SEED_TARGET: '/opt/agent-seed-host-parent/seed;rm -rf /' },
      'companion handoff requires an agent-seed target in the fixed parent',
    ],
  ])('refuses a handoff instructed with %s', async (_case, override, message) => {
    const replace = vi.fn(async () => 'successor-id');
    const publishAgentSeed = vi.fn(async () => undefined);

    await expect(
      runManagedCompanionHandoff(
        { replaceContainerImage: replace },
        {
          VERITY_HANDOFF_UPDATER_ID: 'a'.repeat(64),
          VERITY_HANDOFF_TARGET_IMAGE: targetImage,
          VERITY_HANDOFF_DEPLOYMENT_ID: 'deployment-1',
          VERITY_HANDOFF_AGENT_SEED_TARGET: '/opt/agent-seed-host-parent/agent-seed',
          ...override,
        },
        { publishAgentSeed },
      ),
    ).rejects.toThrow(message);
    // Nothing may have happened yet: neither the seed publish nor the swap.
    expect(publishAgentSeed).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('refuses a handoff on a daemon that cannot swap an image atomically', async () => {
    // Without `replaceContainerImage` the helper would have to stop, remove and
    // recreate the Updater — the non-atomic sequence this protocol exists to
    // avoid, since a crash between the steps leaves the deployment with no
    // Updater at all.
    await expect(
      runManagedCompanionHandoff(
        {},
        {
          VERITY_HANDOFF_UPDATER_ID: 'a'.repeat(64),
          VERITY_HANDOFF_TARGET_IMAGE: targetImage,
          VERITY_HANDOFF_DEPLOYMENT_ID: 'deployment-1',
          VERITY_HANDOFF_AGENT_SEED_TARGET: '/opt/agent-seed-host-parent/agent-seed',
        },
        { publishAgentSeed: async () => undefined },
      ),
    ).rejects.toThrow('companion handoff requires atomic image replacement');
  });

  it.each([
    ['listContainers' as const, 'managed companion reconciliation requires container listing'],
    [
      'replaceContainerImage' as const,
      'managed companion reconciliation requires atomic image replacement',
    ],
  ])('refuses to reconcile on a daemon without %s', async (capability, message) => {
    const state = fake({ gateway: oldImage, updater: oldImage });

    await expect(
      reconcileManagedCompanions({
        managedRoot: '/managed',
        docker: withoutCapability(state.docker, capability),
        journal,
        reconcileRunner: () => Promise.resolve(),
      }),
    ).rejects.toThrow(message);
    expect(state.replacements).toEqual([]);
  });

  it.each([
    [
      'no read-only agent-seed mount at all',
      [
        {
          type: 'bind',
          source: '/opt/agent-seed',
          destination: '/opt/elsewhere',
          readWrite: false,
        },
      ],
      'managed Updater has no read-only agent-seed host mount',
    ],
    [
      'a writable agent-seed mount',
      [
        {
          type: 'bind',
          source: '/opt/agent-seed',
          destination: '/opt/agent-seed',
          readWrite: true,
        },
      ],
      'managed Updater has no read-only agent-seed host mount',
    ],
    [
      'an agent-seed host directory whose name is not a plain path segment',
      [
        {
          type: 'bind',
          source: '/opt/agent seed$(id)',
          destination: '/opt/agent-seed',
          readWrite: false,
        },
      ],
      'managed Updater agent-seed mount has an invalid directory name',
    ],
  ])('refuses to build the handoff helper from %s', async (_case, mounts, message) => {
    // The helper is created with `${dirname(source)}:${AGENT_SEED_PARENT}` and is
    // told the leaf name — so an unreadable or unnameable host directory has to
    // stop the handoff rather than produce a helper bound to the wrong tree.
    const state = fake({ gateway: targetImage, updater: oldImage });
    const updaterId = 'b'.repeat(64);
    state.inspect.set(updaterId, { ...state.inspect.get(updaterId)!, mounts });

    await expect(
      reconcileManagedCompanions({
        managedRoot: '/managed',
        docker: state.docker,
        journal,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(message);
    expect(state.specs).toEqual([]);
  });

  it('pulls the target image once when the handoff helper cannot be created from it', async () => {
    // The successor Updater's image is on the daemon in the normal case, but a
    // pruned daemon would otherwise strand the update at `reconciling-companions`
    // with no way forward — the old Updater cannot replace itself.
    const state = fake({ gateway: targetImage, updater: oldImage });
    let attempts = 0;
    state.docker.createContainer.mockImplementation(async (spec: ContainerSpec) => {
      attempts += 1;
      if (attempts === 1)
        throw Object.assign(new Error('no such image'), { kind: 'image_not_found' });
      state.specs.push(spec);
      return { id: 'c'.repeat(64), warnings: [] };
    });
    const handoff = new Error('handoff started');

    await expect(
      reconcileManagedCompanions({
        managedRoot: '/managed',
        docker: state.docker,
        journal,
        sleep: async () => undefined,
        waitForHandoff: async () => {
          throw handoff;
        },
      }),
    ).rejects.toBe(handoff);

    expect(state.docker.pullImage).toHaveBeenCalledWith(targetImage);
    expect(state.specs).toHaveLength(1);
    expect(state.started).toEqual(['c'.repeat(64)]);
  });

  it('surfaces a create failure that pulling the image cannot fix', async () => {
    const state = fake({ gateway: targetImage, updater: oldImage });
    state.docker.createContainer.mockRejectedValue(
      Object.assign(new Error('name already in use'), { kind: 'conflict' }),
    );

    await expect(
      reconcileManagedCompanions({
        managedRoot: '/managed',
        docker: state.docker,
        journal,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow('name already in use');
    expect(state.docker.pullImage).not.toHaveBeenCalled();
  });

  it('reports the exit status of a handoff helper that failed to take over', async () => {
    // The helper is the process that replaces the Updater. If it exits non-zero
    // the swap did not happen, and reporting success here would complete the
    // journal with the deployment still running the outgoing Updater.
    const state = fake({ gateway: targetImage, updater: oldImage });
    state.docker.waitContainer.mockResolvedValue(3);

    await expect(
      reconcileManagedCompanions({
        managedRoot: '/managed',
        docker: state.docker,
        journal,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow('companion handoff helper exited 3');
  });

  it('refuses the handoff on a daemon that cannot report container exits', async () => {
    const state = fake({ gateway: targetImage, updater: oldImage });

    await expect(
      reconcileManagedCompanions({
        managedRoot: '/managed',
        docker: withoutCapability(state.docker, 'waitContainer'),
        journal,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow('companion handoff requires container wait support');
  });

  it('tears down a handoff helper that never finishes rather than waiting forever', async () => {
    // A wedged helper holds the whole update open. The budget expiring has to
    // both stop and remove it: a helper left running would race the next attempt
    // for the Updater it is replacing.
    vi.useFakeTimers();
    try {
      const state = fake({ gateway: targetImage, updater: oldImage });
      state.docker.waitContainer.mockImplementation(() => new Promise<number>(() => undefined));
      const settled = expect(
        reconcileManagedCompanions({
          managedRoot: '/managed',
          docker: state.docker,
          journal,
          sleep: async () => undefined,
        }),
      ).rejects.toThrow('companion handoff helper timed out');
      // Positive control for the three budget tests below: they prove a timer is
      // gone, which a fake-timer setup that never intercepted this module's
      // `setTimeout` would also "prove". Seeing the budget actually pending here
      // is what makes the zero they assert mean something.
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(120_000);
      await settled;
      expect(state.docker.stopContainer).toHaveBeenCalledWith('c'.repeat(64));
      expect(state.removed).toContain('c'.repeat(64));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('spends no more of the handoff budget once the helper has reported', async () => {
    // The budget above is a deadline, not a delay: a helper that answers in a
    // second must cost a second. Inside the Updater an unspent remainder is
    // invisible — the process outlives it — but the live self-update smoke runs
    // each stage as its own process, and there the leftover timer kept six of
    // them alive for ~119s apiece after their work was done. Asserting on the
    // pending-timer count rather than on elapsed time is what makes that
    // regression fail here in milliseconds instead of in the release gate.
    vi.useFakeTimers();
    try {
      const state = fake({ gateway: targetImage, updater: oldImage });

      await reconcileManagedCompanions({
        managedRoot: '/managed',
        docker: state.docker,
        journal,
        sleep: async () => undefined,
        reconcileRunner: async () => undefined,
      });

      expect(state.docker.waitContainer).toHaveBeenCalledWith('c'.repeat(64));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('spends no more of the handoff budget once the wait itself fails', async () => {
    // The failing wait is the other way out of the race, and it leaked the same
    // timer: a daemon that drops the connection mid-wait would leave the budget
    // pending behind an error that reads as immediate. Worth its own case,
    // because a plain `await` on the race covers neither this nor the case below.
    vi.useFakeTimers();
    try {
      const state = fake({ gateway: targetImage, updater: oldImage });
      state.docker.waitContainer.mockRejectedValue(new Error('daemon closed the connection'));

      await expect(
        reconcileManagedCompanions({
          managedRoot: '/managed',
          docker: state.docker,
          journal,
          sleep: async () => undefined,
          reconcileRunner: async () => undefined,
        }),
      ).rejects.toThrow('daemon closed the connection');

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('spends no more of the handoff budget when the wait throws before returning', async () => {
    // This is the case that decides the shape: the throw happens while the race's
    // arguments are evaluated, so it escapes after the timer is armed but before
    // anything can be attached to the race. `.finally` on the race would never
    // run; only a `try`/`finally` around it clears the budget here.
    vi.useFakeTimers();
    try {
      const state = fake({ gateway: targetImage, updater: oldImage });
      state.docker.waitContainer.mockImplementation(() => {
        throw new Error('docker client rejected the wait outright');
      });

      await expect(
        reconcileManagedCompanions({
          managedRoot: '/managed',
          docker: state.docker,
          journal,
          sleep: async () => undefined,
          reconcileRunner: async () => undefined,
        }),
      ).rejects.toThrow('docker client rejected the wait outright');

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('names the companion whose own healthcheck reported failure', async () => {
    const state = fake({ gateway: targetImage, updater: targetImage });
    const agentId = 'd'.repeat(64);
    state.docker.inspectContainer.mockImplementation(async (id: string) => {
      const current = state.inspect.get(id)!;
      return id === agentId ? { ...current, healthStatus: 'unhealthy' } : current;
    });

    await expect(
      reconcileManagedCompanions({
        managedRoot: '/managed',
        docker: state.docker,
        journal,
        reconcileRunner: () => Promise.resolve(),
        sleep: async () => undefined,
      }),
    ).rejects.toThrow('Agent Gateway is unhealthy');
  });

  it('distinguishes a companion that died from one that never reported health', async () => {
    // `exited during startup` and `did not become healthy` send an operator to
    // different places — the container's logs versus its healthcheck — so a
    // container that dies mid-settle must not be reported as merely slow.
    const state = fake({ gateway: targetImage, updater: targetImage });
    const agentId = 'd'.repeat(64);
    let reads = 0;
    state.docker.inspectContainer.mockImplementation(async (id: string) => {
      const current = state.inspect.get(id)!;
      if (id !== agentId) return current;
      reads += 1;
      return { ...current, running: reads < 2, healthStatus: 'starting' };
    });

    await expect(
      reconcileManagedCompanions({
        managedRoot: '/managed',
        docker: state.docker,
        journal,
        reconcileRunner: () => Promise.resolve(),
        sleep: async () => undefined,
      }),
    ).rejects.toThrow('Agent Gateway exited during startup');
  });

  /**
   * Which inspection is the one taken AT the deadline: the reconcile identifies
   * the service with one, `ensureRunning` takes one before its loop, and the loop
   * itself samples every 500ms up to the 120s ceiling. The reading after the last
   * sample is a reading like any other — a container that only commits to a
   * verdict as the budget runs out must be judged on what it says rather than
   * rolled back for having been slow.
   */
  const DEADLINE_READ = 1 + 1 + 120_000 / 500;

  it.each([
    ['turns healthy exactly at the deadline', { running: true, healthStatus: 'healthy' }, null],
    [
      'reports unhealthy exactly at the deadline',
      { running: true, healthStatus: 'unhealthy' },
      'Agent Gateway is unhealthy',
    ],
    [
      'has exited by the deadline',
      { running: false, healthStatus: 'starting' },
      'Agent Gateway exited during startup',
    ],
    [
      'is still starting at the deadline',
      { running: true, healthStatus: 'starting' },
      'Agent Gateway did not become healthy',
    ],
  ])('judges a companion on the reading taken when it %s', async (_case, final, message) => {
    const state = fake({ gateway: targetImage, updater: targetImage });
    const agentId = 'd'.repeat(64);
    let reads = 0;
    state.docker.inspectContainer.mockImplementation(async (id: string) => {
      const current = state.inspect.get(id)!;
      if (id !== agentId) return current;
      reads += 1;
      return reads < DEADLINE_READ
        ? { ...current, running: true, healthStatus: 'starting' }
        : { ...current, ...final };
    });

    const reconcile = reconcileManagedCompanions({
      managedRoot: '/managed',
      docker: state.docker,
      journal,
      reconcileRunner: () => Promise.resolve(),
      sleep: async () => undefined,
    });
    if (message === null) await expect(reconcile).resolves.toBeUndefined();
    else await expect(reconcile).rejects.toThrow(message);
    expect(reads).toBe(DEADLINE_READ);
  });

  it('clears its own spent handoff helpers and leaves another deployment alone', async () => {
    // The helper outlives the Updater it replaced, so the successor is the only
    // process that can retire it. Reaping by role alone would take a concurrent
    // deployment's live handoff down with it.
    const state = fake({ gateway: targetImage, updater: targetImage });
    const spent = {
      id: 'e'.repeat(64),
      imageId: 'e'.repeat(64),
      names: ['verity-managed-companion-handoff-g7'],
      labels: {
        'verity.managed-deployment-id': 'deployment-1',
        'verity.managed-role': 'companion-handoff',
      },
    };
    const foreign = {
      ...spent,
      id: 'f'.repeat(64),
      labels: { ...spent.labels, 'verity.managed-deployment-id': 'deployment-2' },
    };
    state.summaries.push(spent, foreign);

    await reconcileManagedCompanions({
      managedRoot: '/managed',
      docker: state.docker,
      journal,
      reconcileRunner: () => Promise.resolve(),
      sleep: async () => undefined,
    });

    expect(state.removed).toEqual([spent.id]);
  });

  it('reuses an immutable digest and switches the complete tree through one pointer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-agent-seed-stale-'));
    const source = await seedSource(root);
    const target = join(root, 'seed');
    await writeFile(join(source, 'release-only'), 'first');

    await publishAgentSeedAtomically(
      source,
      target,
      targetImage,
      '13.1.5',
      () => new Date('2026-08-14T00:00:00Z'),
    );
    const firstPointer = await readlink(join(target, '.current'));
    expect(await readFile(join(target, '.current', 'release-only'), 'utf8')).toBe('first');

    await writeFile(join(source, 'release-only'), 'must not replace immutable bytes');
    await publishAgentSeedAtomically(
      source,
      target,
      targetImage,
      '13.1.5',
      () => new Date('2026-08-15T00:00:00Z'),
    );

    expect(await readlink(join(target, '.current'))).toBe(firstPointer);
    expect(await readFile(join(target, '.current', 'release-only'), 'utf8')).toBe('first');
    expect(await readFile(join(target, '.current', '.verity-agent-seed'), 'utf8')).toContain(
      'published=2026-08-14T00:00:00.000Z',
    );
  });

  it('leaves the active pointer unchanged when staged validation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-agent-seed-invalid-'));
    const source = await seedSource(root);
    const target = join(root, 'seed');
    await publishAgentSeedAtomically(source, target, oldImage, '13.1.4');
    const previous = await readlink(join(target, '.current'));
    await rm(join(source, 'bin', 'verity-git-sign'));

    await expect(publishAgentSeedAtomically(source, target, targetImage, '13.1.5')).rejects.toThrow(
      'required file is missing: bin/verity-git-sign',
    );
    expect(await readlink(join(target, '.current'))).toBe(previous);
    await expect(lstat(join(target, '.versions', `${'b'.repeat(64)}.next`))).resolves.toBeTruthy();
  });

  it('discards interrupted staging and resumes idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-agent-seed-resume-'));
    const source = await seedSource(root);
    const target = join(root, 'seed');
    const interrupted = join(target, '.versions', `${'b'.repeat(64)}.next`);
    await mkdir(interrupted, { recursive: true });
    await writeFile(join(interrupted, 'partial-wrapper'), 'partial');

    await publishAgentSeedAtomically(source, target, targetImage, '13.1.5');
    expect(await readlink(join(target, '.current'))).toBe(`.versions/${'b'.repeat(64)}`);
    await expect(lstat(interrupted)).rejects.toMatchObject({ code: 'ENOENT' });

    const selected = await stat(join(target, '.current'));
    await publishAgentSeedAtomically(source, target, targetImage, '13.1.5');
    expect((await stat(join(target, '.current'))).ino).toBe(selected.ino);
  });

  it('rolls the pointer back when post-promotion verification fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-agent-seed-rollback-'));
    const source = await seedSource(root);
    const target = join(root, 'seed');
    await publishAgentSeedAtomically(source, target, oldImage, '13.1.4');
    const previous = await readlink(join(target, '.current'));

    await expect(
      publishAgentSeedAtomically(source, target, targetImage, '13.1.5', undefined, async () => {
        throw new Error('injected verification failure');
      }),
    ).rejects.toThrow('injected verification failure');
    expect(await readlink(join(target, '.current'))).toBe(previous);
    expect(await readFile(join(target, '.current', '.verity-agent-seed'), 'utf8')).toContain(
      `image=${oldImage}`,
    );
  });

  it('restores an absent pointer when first-promotion verification fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-agent-seed-first-rollback-'));
    const source = await seedSource(root);
    const target = join(root, 'seed');

    await expect(
      publishAgentSeedAtomically(source, target, targetImage, '13.1.5', undefined, async () => {
        throw new Error('injected first verification failure');
      }),
    ).rejects.toThrow('injected first verification failure');
    await expect(lstat(join(target, '.current'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves standalone publication from a local image reference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-agent-seed-local-'));
    const source = await seedSource(root);
    const target = join(root, 'seed');
    const localImage = 'verity-server:development';

    await publishAgentSeedAtomically(source, target, localImage, '0.0.0-dev');
    expect(await readFile(join(target, '.current', '.verity-agent-seed'), 'utf8')).toContain(
      `image=${localImage}`,
    );
    const first = await readlink(join(target, '.current'));
    await publishAgentSeedAtomically(source, target, localImage, '0.0.1-dev');
    expect(await readlink(join(target, '.current'))).not.toBe(first);
    expect(await readFile(join(target, '.current', '.verity-agent-seed'), 'utf8')).toContain(
      'version=0.0.1-dev',
    );
  });

  it('makes managed publication wait for complete bootstrap ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-agent-seed-bootstrap-race-'));
    const source = await seedSource(root);
    const target = join(root, 'seed');

    await expect(
      publishAgentSeedAtomically(source, target, targetImage, '13.1.5', undefined, undefined, true),
    ).rejects.toThrow('requires a complete bootstrap or legacy selection');
    await expect(lstat(join(target, '.current'))).rejects.toMatchObject({ code: 'ENOENT' });

    await publishAgentSeedAtomically(source, target, oldImage, '13.1.4');
    await publishAgentSeedAtomically(
      source,
      target,
      targetImage,
      '13.1.5',
      undefined,
      undefined,
      true,
    );
    expect(await readlink(join(target, '.current'))).toBe(`.versions/${'b'.repeat(64)}`);
  });

  it('migrates the first managed update from a complete legacy flat seed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-agent-seed-legacy-'));
    const source = await seedSource(root);
    const target = join(root, 'seed');
    await cp(source, target, { recursive: true });
    await writeFile(
      join(target, '.verity-agent-seed'),
      `schema=1\nimage=${oldImage}\nversion=13.1.4\npublished=2026-08-01T00:00:00Z\n`,
    );

    await publishAgentSeedAtomically(
      source,
      target,
      targetImage,
      '13.1.5',
      undefined,
      undefined,
      true,
    );
    expect(await readlink(join(target, '.current'))).toBe(`.versions/${'b'.repeat(64)}`);
    // Existing legacy sandboxes still bind the root and keep its complete flat
    // files; only newly created sandboxes resolve `.current`.
    expect(await readFile(join(target, '.verity-agent-seed'), 'utf8')).toContain(
      `image=${oldImage}`,
    );
  });
});
