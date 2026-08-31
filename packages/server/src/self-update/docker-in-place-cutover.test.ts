import { describe, expect, it } from 'vitest';
import type { ContainerSpec } from '../docker.js';
import { dockerStandbyPromotion } from './docker-in-place-cutover.js';
import { dockerUpdatePreparation } from './docker-update-preparation.js';
import { readManagedDeployment } from './managed-deployment.js';
import { MANAGED_SERVER_NAME } from './managed-server-owner.js';
import { createUpdateJournalCutoverStore, resumeUpdateCutover } from './update-cutover.js';
import { beginUpdate, readUpdateJournal } from './update-journal.js';
import { resumeUpdatePreparation } from './update-preparation.js';
import { createStandbyExchange, type StandbyExchange } from './standby-directive.js';
import {
  adoptedDeployment,
  DEPLOYMENT_ID,
  ENVIRONMENT,
  newImage,
  oldImage,
  type FakeDaemon,
} from './managed-daemon.test-helper.js';

/** A deployment that has already been adopted, is serving the old digest, and
 *  has a prepared standby waiting — the exact state a cutover starts from. */
async function prepared() {
  const { root, daemon, oldContainerId } = await adoptedDeployment('docker-in-place-cutover');
  await beginUpdate({
    root,
    deploymentId: DEPLOYMENT_ID,
    idempotencyKey: 'request-1',
    previousDigest: oldImage,
    targetDigest: newImage,
    currentGeneration: 0,
  });
  const journal = await resumeUpdatePreparation(
    root,
    await dockerUpdatePreparation({
      managedRoot: root,
      docker: daemon.docker,
      environment: ENVIRONMENT,
      verifyImage: async () => Promise.resolve(),
    }),
  );
  return { root, daemon, journal, oldContainerId };
}

const gateways = new WeakMap<
  FakeDaemon,
  { maintenance: boolean; backend: string; switches: string[]; drains: number[] }
>();

const gatewayControl = (daemon: FakeDaemon) => {
  const state = gateways.get(daemon) ?? {
    maintenance: false,
    backend: MANAGED_SERVER_NAME,
    switches: [],
    drains: [],
  };
  gateways.set(daemon, state);
  return {
    status: async () => ({ maintenance: state.maintenance, backend: { host: state.backend } }),
    enterMaintenance: async () => {
      state.maintenance = true;
    },
    leaveMaintenance: async () => {
      state.maintenance = false;
    },
    drain: async (timeoutMs: number) => {
      state.drains.push(timeoutMs);
    },
    switchBackend: async (host: string) => {
      if (!state.maintenance) throw new Error('switch requires maintenance');
      state.backend = host;
      state.switches.push(host);
    },
  };
};

const cutover = (root: string, daemon: FakeDaemon) =>
  dockerStandbyPromotion({
    managedRoot: root,
    docker: daemon.docker,
    environment: ENVIRONMENT,
    readinessTimeoutMs: 5_000,
    observeMs: 100,
    observeTimeoutMs: 5_000,
    sleep: async () => Promise.resolve(),
    activate: async () => Promise.resolve(),
    gateway: gatewayControl(daemon),
  });

describe('standby promotion cutover', () => {
  it('promotes the generation-qualified candidate and retires the old Server', async () => {
    const { root, daemon, journal } = await prepared();
    await expect(resumeUpdateCutover(await cutover(root, daemon))).resolves.toMatchObject({
      phase: 'committed',
    });

    const state = await readManagedDeployment(root);
    expect(state.managed && state.spec.image).toBe(newImage);
    // The sealed authority is what survives a reboot, so it — not the journal —
    // is what makes the update durable.
    expect(daemon.spec('verity-managed-server-g1')?.image).toBe(newImage);
    expect(daemon.status('verity-managed-server-g1')).toBe('running');
    expect(daemon.names()).toEqual(['verity-managed-server-g1']);
    expect(daemon.find('verity-managed-server-g1')).toBe(journal.candidate?.containerId);
    expect(daemon.find(MANAGED_SERVER_NAME)).toBeUndefined();
    expect(gateways.get(daemon)).toMatchObject({
      maintenance: false,
      backend: 'verity-managed-server-g1',
      drains: [30_000],
    });
  });

  it('restores traffic when stopping the old Server fails before it is fenced', async () => {
    const { root, daemon } = await prepared();
    daemon.docker.stopContainer = async () => {
      throw new Error('daemon busy');
    };

    await expect(resumeUpdateCutover(await cutover(root, daemon))).rejects.toThrow('daemon busy');
    expect(gateways.get(daemon)).toMatchObject({ maintenance: false });
    expect(await readUpdateJournal(root)).toMatchObject({ phase: 'quiescing-old' });
    expect(daemon.status(MANAGED_SERVER_NAME)).toBe('running');
  });

  it('restores traffic on a resumed quiesce that inherited maintenance', async () => {
    const { root, daemon } = await prepared();
    gateways.set(daemon, {
      maintenance: true,
      backend: MANAGED_SERVER_NAME,
      switches: [],
      drains: [],
    });
    daemon.docker.stopContainer = async () => {
      throw new Error('daemon busy');
    };

    await expect(resumeUpdateCutover(await cutover(root, daemon))).rejects.toThrow('daemon busy');
    expect(gateways.get(daemon)).toMatchObject({ maintenance: false });
    expect(daemon.status(MANAGED_SERVER_NAME)).toBe('running');
  });

  it('probes readiness from a throwaway container that carries no deployment state', async () => {
    const { root, daemon } = await prepared();
    await resumeUpdateCutover(await cutover(root, daemon));

    const created = (
      daemon.docker.createContainer as unknown as { mock: { calls: [ContainerSpec][] } }
    ).mock.calls.map(([spec]) => spec);
    const probes = created.filter((spec) => spec.name.startsWith('verity-managed-probe-'));
    expect(probes.map((spec) => spec.name)).toEqual([
      'verity-managed-probe-ready-g1',
      'verity-managed-probe-observe-g1',
    ]);
    for (const probe of probes)
      expect(probe).toMatchObject({
        image: newImage,
        command: ['readiness-probe'],
        network: 'verity-net',
        restartPolicy: 'no',
        readOnlyRootfs: true,
        binds: [],
        volumeMounts: [],
        capAdd: [],
        groupAdd: [],
        securityOpt: ['no-new-privileges:true'],
        env: [
          'VERITY_READINESS_PROBE_URL=http://verity-managed-server-g1:8082/healthz',
          'VERITY_READINESS_PROBE_TIMEOUT_MS=5000',
        ],
      });
  });

  it('rolls back to the previous digest when the new generation never serves', async () => {
    const { root, daemon } = await prepared();
    daemon.exitCodes.set('verity-managed-probe-ready-g1', 1);
    daemon.logs.set('verity-managed-probe-ready-g1', 'connect ECONNREFUSED');

    await expect(resumeUpdateCutover(await cutover(root, daemon))).rejects.toThrow(
      /readiness probe \(ready\) failed with exit code 1/,
    );

    const state = await readManagedDeployment(root);
    expect(state.managed && state.spec.image).toBe(oldImage);
    expect(daemon.spec(MANAGED_SERVER_NAME)?.image).toBe(oldImage);
    expect(daemon.status(MANAGED_SERVER_NAME)).toBe('running');
    expect(daemon.names()).toEqual([MANAGED_SERVER_NAME]);
    expect(await readUpdateJournal(root)).toMatchObject({ phase: 'rolled-back' });
  });

  it('proves the retained Server on its own endpoint and budget, not the candidate’s', async () => {
    // A caller that forces a rollback by pointing the candidate probe at
    // something unserved must not thereby poison the proof that the old
    // generation came back — the live smoke does exactly this, and probing the
    // restored Server on the dead port reported a rollback that had in fact
    // succeeded.
    const { root, daemon } = await prepared();
    daemon.exitCodes.set('verity-managed-probe-ready-g1', 1);

    await expect(
      resumeUpdateCutover(
        await dockerStandbyPromotion({
          managedRoot: root,
          docker: daemon.docker,
          environment: ENVIRONMENT,
          probeUrl: 'http://verity-managed-server:8099/healthz',
          rollbackProbe: {
            url: 'http://verity-managed-server:8082/healthz',
            readinessTimeoutMs: 30_000,
          },
          readinessTimeoutMs: 5_000,
          observeMs: 100,
          observeTimeoutMs: 5_000,
          sleep: async () => Promise.resolve(),
          activate: async () => Promise.resolve(),
          gateway: gatewayControl(daemon),
        }),
      ),
    ).rejects.toThrow(/readiness probe \(ready\) failed/);

    const created = (
      daemon.docker.createContainer as unknown as { mock: { calls: [ContainerSpec][] } }
    ).mock.calls.map(([spec]) => spec);
    const env = (name: string) => created.find((spec) => spec.name === name)?.env;
    expect(env('verity-managed-probe-ready-g1')).toEqual([
      'VERITY_READINESS_PROBE_URL=http://verity-managed-server-g1:8099/healthz',
      'VERITY_READINESS_PROBE_TIMEOUT_MS=5000',
    ]);
    expect(env('verity-managed-probe-rollback-old-g1')).toEqual([
      `VERITY_READINESS_PROBE_URL=http://${MANAGED_SERVER_NAME}:8082/healthz`,
      'VERITY_READINESS_PROBE_TIMEOUT_MS=30000',
    ]);
    expect(await readUpdateJournal(root)).toMatchObject({ phase: 'rolled-back' });
  });

  it('suppresses restart churn when the retained rollback generation is unhealthy', async () => {
    const { root, daemon } = await prepared();
    daemon.exitCodes.set('verity-managed-probe-ready-g1', 1);
    daemon.exitCodes.set('verity-managed-probe-rollback-old-g1', 1);

    await expect(resumeUpdateCutover(await cutover(root, daemon))).rejects.toBeInstanceOf(
      AggregateError,
    );
    expect(daemon.status(MANAGED_SERVER_NAME)).toBe('exited');
    expect(await readUpdateJournal(root)).toMatchObject({ phase: 'rollback-activating-old' });
  });

  it('restores the still-old generation when activation itself fails', async () => {
    const { root, daemon, oldContainerId } = await prepared();
    const deps = await cutover(root, daemon);
    // Quiesce stops rather than removes, so the pre-activation window recovers
    // by starting the very same container back up.
    await deps.quiesceOld({
      operationId: 'update-1',
      phase: 'quiescing-old',
      oldGeneration: 0,
      candidateGeneration: 1,
      oldContainerId,
      candidateContainerId: 'f'.repeat(64),
    });
    expect(daemon.status(MANAGED_SERVER_NAME)).toBe('exited');

    await deps.activateOld({
      operationId: 'update-1',
      phase: 'rollback-activating-old',
      oldGeneration: 0,
      candidateGeneration: 1,
      oldContainerId,
      candidateContainerId: 'f'.repeat(64),
    });
    expect(daemon.find(MANAGED_SERVER_NAME)).toBe(oldContainerId);
    expect(daemon.status(MANAGED_SERVER_NAME)).toBe('running');
  });

  /**
   * The rollback leg restarts the RETAINED container by id. It does not rebuild
   * it, and it does not judge it against the sealed spec.
   *
   * That is correct as written, and it is load-bearing rather than incidental.
   * `activateOld` re-seals the PREVIOUS digest and then brings back the container
   * that was serving before the attempt — a container this same operation stopped
   * moments ago, so it is by construction the right one. A rollback that started
   * comparing it to the spec would put the fatal refusal back inside the cutover,
   * at the one point where there is nothing left to fall back to: the candidate
   * has been quiesced, the Gateway is mid-flight, and a throw here strands the
   * deployment with no Server at all.
   *
   * Pinned with a difference the comparison would call structural, so the test
   * fails under any comparison anyone might add rather than only a lenient one.
   */
  it('restarts the retained Server by id without re-comparing it to the sealed spec', async () => {
    const { root, daemon, oldContainerId } = await prepared();
    const deps = await cutover(root, daemon);
    const state = {
      operationId: 'update-1',
      phase: 'rollback-activating-old' as const,
      oldGeneration: 0,
      candidateGeneration: 1,
      oldContainerId,
      candidateContainerId: 'f'.repeat(64),
    };
    await deps.quiesceOld({ ...state, phase: 'quiescing-old' });
    expect(daemon.status(MANAGED_SERVER_NAME)).toBe('exited');

    // A variable the sealed spec does not supply and the image does not bake:
    // `describeManagedContainerMismatch` calls that structural, and
    // `reconcileManagedServer` refuses it running or stopped.
    const retained = daemon.spec(MANAGED_SERVER_NAME)!;
    retained.env = [...(retained.env ?? []), 'NODE_OPTIONS=--require /injected.js'];

    await deps.activateOld(state);
    expect(daemon.find(MANAGED_SERVER_NAME)).toBe(oldContainerId);
    expect(daemon.status(MANAGED_SERVER_NAME)).toBe('running');
  });

  it('re-runs activation after a crash without duplicating or losing the Server', async () => {
    const { root, daemon, journal, oldContainerId } = await prepared();
    const deps = await cutover(root, daemon);
    const state = {
      operationId: journal.updateId,
      phase: 'activating-candidate' as const,
      oldGeneration: 0,
      candidateGeneration: 1,
      oldContainerId,
      candidateContainerId: journal.candidate!.containerId,
    };
    await deps.activateCandidate(state);
    const first = daemon.find('verity-managed-server-g1');
    // Exactly what a SIGKILL between the action and its journal transition does.
    await deps.activateCandidate(state);
    expect(daemon.find('verity-managed-server-g1')).toBe(first);
    expect(daemon.names()).toEqual([MANAGED_SERVER_NAME, 'verity-managed-server-g1']);
    const advanced = await readManagedDeployment(root);
    expect(advanced.managed && advanced.spec.image).toBe(newImage);
  });

  it('quiesces only the journal-bound candidate and never the old Server', async () => {
    const { root, daemon, journal, oldContainerId } = await prepared();
    const deps = await cutover(root, daemon);
    const state = {
      operationId: journal.updateId,
      phase: 'rollback-quiescing-candidate' as const,
      oldGeneration: 0,
      candidateGeneration: 1,
      oldContainerId,
      candidateContainerId: journal.candidate!.containerId,
    };
    await deps.quiesceCandidate(state);
    expect(daemon.find(MANAGED_SERVER_NAME)).toBe(oldContainerId);
    expect(daemon.status('verity-managed-server-g1')).toBe('exited');
  });

  it('replays route switches safely after either response is lost', async () => {
    const { root, daemon, journal, oldContainerId } = await prepared();
    const deps = await cutover(root, daemon);
    const state = {
      operationId: journal.updateId,
      phase: 'switching-gateway' as const,
      oldGeneration: 0,
      candidateGeneration: 1,
      oldContainerId,
      candidateContainerId: journal.candidate!.containerId,
    };
    await deps.quiesceOld(state);
    await deps.activateCandidate(state);
    await deps.switchGatewayToCandidate(state);
    await deps.switchGatewayToCandidate(state);
    expect(gateways.get(daemon)).toMatchObject({
      backend: 'verity-managed-server-g1',
      maintenance: false,
    });

    await deps.quiesceCandidate(state);
    await deps.activateOld(state);
    await deps.switchGatewayToOld(state);
    await deps.switchGatewayToOld(state);
    expect(gateways.get(daemon)).toMatchObject({
      backend: MANAGED_SERVER_NAME,
      maintenance: false,
    });
    expect(daemon.names()).toEqual([MANAGED_SERVER_NAME]);
  });

  it('refuses to start when the running Server cannot be identified', async () => {
    const { root, daemon, oldContainerId } = await prepared();
    await daemon.docker.removeContainer(oldContainerId);
    await expect(cutover(root, daemon)).rejects.toThrow(/cannot identify the running managed/);
  });

  /**
   * A probe that never returns a verdict is the worst shape this path has: the
   * old generation is stopped, so an executor that simply keeps waiting leaves
   * the deployment in maintenance. The wait is bounded by
   * the executor's own budget, and the stuck probe container is force-removed on
   * the way out rather than left occupying its reserved name.
   */
  it('gives up on a probe that never finishes and rolls back', async () => {
    const { root, daemon } = await prepared();
    const wait = daemon.docker.waitContainer!.bind(daemon.docker);
    daemon.docker.waitContainer = async (id: string) =>
      id === daemon.find('verity-managed-probe-ready-g1')
        ? new Promise<number>(() => undefined)
        : wait(id);

    await expect(
      resumeUpdateCutover(
        await dockerStandbyPromotion({
          managedRoot: root,
          docker: daemon.docker,
          environment: ENVIRONMENT,
          readinessTimeoutMs: 1_000,
          probeGraceMs: 10,
          observeMs: 0,
          observeTimeoutMs: 1_000,
          sleep: async () => Promise.resolve(),
          activate: async () => Promise.resolve(),
          gateway: gatewayControl(daemon),
        }),
      ),
    ).rejects.toThrow(/readiness probe \(ready\) did not finish within 1010ms/);

    const state = await readManagedDeployment(root);
    expect(state.managed && state.spec.image).toBe(oldImage);
    expect(daemon.status(MANAGED_SERVER_NAME)).toBe('running');
    expect(daemon.names()).toEqual([MANAGED_SERVER_NAME]);
    expect(await readUpdateJournal(root)).toMatchObject({ phase: 'rolled-back' });
  });

  /**
   * Every other test here injects a `sleep`, which hides what this one is about:
   * the observation window can be the ONLY pending work in the Updater process,
   * because startup recovery runs before the control boundary opens. An
   * `unref`'d timer would let Node run the loop dry and exit mid-cutover, and
   * the restart would resume at the same phase and exit again — an update that
   * never commits and never rolls back.
   */
  it('observes with a timer that keeps the process alive', async () => {
    const { root, daemon, oldContainerId } = await prepared();
    const deps = await dockerStandbyPromotion({
      managedRoot: root,
      docker: daemon.docker,
      environment: ENVIRONMENT,
      readinessTimeoutMs: 5_000,
      observeMs: 20,
      observeTimeoutMs: 5_000,
      gateway: gatewayControl(daemon),
    });
    const state = await createUpdateJournalCutoverStore(root, oldContainerId).read();
    const timers = (): number =>
      process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;

    const before = timers();
    const observing = deps.observeCandidate(state);

    expect(timers()).toBe(before + 1);
    await observing;
  });
});

/**
 * The standby directive (ADR 0008 D9) replaces the container stop with a live
 * quiesce: the outgoing Server gives up its generation, its pools and its
 * listeners but keeps its process, its memory and its unlocked key. Every
 * property here has to hold both ways, because a Server from an image that
 * predates the directive never answers one and the container stop stays the
 * fallback path forever.
 */
describe('standby promotion against a Server that answers the directive', () => {
  /** A Server that follows the directive the instant the cutover publishes it —
   *  what the follower loop does, minus the polling. */
  function following(): StandbyExchange {
    const exchange = createStandbyExchange();
    return {
      ...exchange,
      request: (operationId, directive) => {
        exchange.request(operationId, directive);
        exchange.acknowledge(operationId, directive);
      },
    };
  }

  const OPERATION = 'generation-1';
  const ids = (fn: unknown): string[] =>
    (fn as { mock: { calls: [string][] } }).mock.calls.map(([id]) => id);
  /** Adoption itself starts the old container, so only what happens from here
   *  on says anything about the cutover. */
  const since = (fn: unknown): (() => string[]) => {
    const before = ids(fn).length;
    return () => ids(fn).slice(before);
  };

  const standbyCutover = (
    root: string,
    daemon: FakeDaemon,
    standby: StandbyExchange,
    standbyTimeoutMs = 5_000,
  ) =>
    dockerStandbyPromotion({
      managedRoot: root,
      docker: daemon.docker,
      environment: ENVIRONMENT,
      readinessTimeoutMs: 5_000,
      observeMs: 100,
      observeTimeoutMs: 5_000,
      sleep: async () => Promise.resolve(),
      activate: async () => Promise.resolve(),
      gateway: gatewayControl(daemon),
      standby,
      standbyTimeoutMs,
    });

  const cutoverState = (
    oldContainerId: string,
    phase: 'quiescing-old' | 'rollback-activating-old',
  ) =>
    ({
      operationId: 'update-1',
      phase,
      oldGeneration: 0,
      candidateGeneration: 1,
      oldContainerId,
      candidateContainerId: 'f'.repeat(64),
    }) as const;

  /** The point of the whole exercise: the maintenance window no longer contains
   *  a container stop, so there is a live process for a rollback to return to. */
  it('leaves the old Server running once it gives up the control plane', async () => {
    const { root, daemon, oldContainerId } = await prepared();
    const standby = following();
    const deps = await standbyCutover(root, daemon, standby);

    await deps.quiesceOld(cutoverState(oldContainerId, 'quiescing-old'));

    expect(daemon.status(MANAGED_SERVER_NAME)).toBe('running');
    expect(ids(daemon.docker.stopContainer)).not.toContain(oldContainerId);
    // Asked only after the drain, and under the generation the candidate is
    // being promoted into — the id the old Server reads out of the directive.
    expect(gateways.get(daemon)).toMatchObject({ maintenance: true, drains: [30_000] });
    expect(standby.requested(OPERATION)).toBe('quiesced');
  });

  /** A Server that cannot or will not quiesce is still in the way of the
   *  candidate, so the bounded wait buys a second of downtime and then does
   *  what this phase always did. */
  it('stops a Server that does not answer within the window', async () => {
    const { root, daemon, oldContainerId } = await prepared();
    const deaf = createStandbyExchange();
    const deps = await standbyCutover(root, daemon, deaf, 10);

    await deps.quiesceOld(cutoverState(oldContainerId, 'quiescing-old'));

    expect(daemon.status(MANAGED_SERVER_NAME)).toBe('exited');
    expect(deaf.requested(OPERATION)).toBe('quiesced');
  });

  /** An acknowledgement of the other state is not an acknowledgement. */
  it('stops a Server that answers with the state it was not asked for', async () => {
    const { root, daemon, oldContainerId } = await prepared();
    const exchange = createStandbyExchange();
    const wrong: StandbyExchange = {
      ...exchange,
      request: (operationId) => exchange.acknowledge(operationId, 'serving'),
    };
    const deps = await standbyCutover(root, daemon, wrong, 10);

    await deps.quiesceOld(cutoverState(oldContainerId, 'quiescing-old'));

    expect(daemon.status(MANAGED_SERVER_NAME)).toBe('exited');
  });

  /**
   * The recovery path reopens traffic when the incumbent is still running. With
   * a standby that is exactly what "running" stops proving: an acknowledgement
   * that lands after the wait gave up leaves a live container holding no
   * listeners, and leaving maintenance would route every request into it.
   */
  it('stays in maintenance when the incumbent may have quiesced after all', async () => {
    const { root, daemon, oldContainerId } = await prepared();
    // A Server that says nothing either way. Whether it quiesced just after the
    // wait gave up, or never followed the directive at all, is precisely what
    // silence does not tell the cutover.
    const silent = createStandbyExchange();
    daemon.docker.stopContainer = async () => {
      throw new Error('daemon busy');
    };
    const deps = await standbyCutover(root, daemon, silent, 10);

    await expect(deps.quiesceOld(cutoverState(oldContainerId, 'quiescing-old'))).rejects.toThrow(
      'daemon busy',
    );

    expect(daemon.status(MANAGED_SERVER_NAME)).toBe('running');
    expect(gateways.get(daemon)).toMatchObject({ maintenance: true });
  });

  /**
   * A follower acknowledges the directive it is already satisfying, so by the
   * time the cutover asks for a quiesce the exchange usually holds a `serving`
   * answer from before the drain. Reading that as the answer to the withdrawal
   * would reopen traffic on the strength of a claim the Server made while it
   * still had the control plane.
   */
  it('does not read an acknowledgement from before the quiesce as an answer to it', async () => {
    const { root, daemon, oldContainerId } = await prepared();
    const exchange = createStandbyExchange();
    exchange.acknowledge(OPERATION, 'serving');
    daemon.docker.stopContainer = async () => {
      throw new Error('daemon busy');
    };
    const deps = await standbyCutover(root, daemon, exchange, 10);

    await expect(deps.quiesceOld(cutoverState(oldContainerId, 'quiescing-old'))).rejects.toThrow(
      'daemon busy',
    );

    expect(gateways.get(daemon)).toMatchObject({ maintenance: true });
  });

  /** The other half of the same rule: a standby that says it serves again is
   *  proof, and traffic reopens exactly as it did before standbys existed. */
  it('reopens traffic once the incumbent takes the control plane back', async () => {
    const { root, daemon, oldContainerId } = await prepared();
    // A Server that would not give the control plane up, but answers plainly
    // that it still has it.
    const exchange = createStandbyExchange();
    const holding: StandbyExchange = {
      ...exchange,
      request: (operationId, directive) => {
        exchange.request(operationId, directive);
        if (directive === 'serving') exchange.acknowledge(operationId, 'serving');
      },
    };
    daemon.docker.stopContainer = async () => {
      throw new Error('daemon busy');
    };
    const deps = await standbyCutover(root, daemon, holding, 10);

    await expect(deps.quiesceOld(cutoverState(oldContainerId, 'quiescing-old'))).rejects.toThrow(
      'daemon busy',
    );

    expect(holding.acknowledged(OPERATION)).toBe('serving');
    expect(gateways.get(daemon)).toMatchObject({ maintenance: false });
  });

  /** The whole forward path, with the old Server's container never touched
   *  until it is retired outright. */
  it('promotes the candidate without ever stopping the old container', async () => {
    const { root, daemon, oldContainerId } = await prepared();

    await expect(
      resumeUpdateCutover(await standbyCutover(root, daemon, following())),
    ).resolves.toMatchObject({ phase: 'committed' });

    expect(ids(daemon.docker.stopContainer)).not.toContain(oldContainerId);
    expect(daemon.names()).toEqual(['verity-managed-server-g1']);
    expect(gateways.get(daemon)).toMatchObject({
      maintenance: false,
      backend: 'verity-managed-server-g1',
    });
  });

  /**
   * The rollback side of the same bargain: a Server that quiesced instead of
   * stopping comes back by building a fresh serving stack under a newer
   * generation, which is neither a container start nor a boot.
   */
  it('brings the quiesced Server back without starting a container', async () => {
    const { root, daemon, oldContainerId } = await prepared();
    const standby = following();
    const deps = await standbyCutover(root, daemon, standby);
    await deps.quiesceOld(cutoverState(oldContainerId, 'quiescing-old'));
    const started = since(daemon.docker.startContainer);

    await deps.activateOld(cutoverState(oldContainerId, 'rollback-activating-old'));

    expect(standby.requested(OPERATION)).toBe('serving');
    expect(started()).not.toContain(oldContainerId);
    expect(daemon.status(MANAGED_SERVER_NAME)).toBe('running');
    // The seal is what survives a reboot, so the rollback is only real once the
    // deployment names the previous digest again.
    const state = await readManagedDeployment(root);
    expect(state.managed && state.spec.image).toBe(oldImage);
  });

  /**
   * "Answered the directive" is a weaker claim than "is serving", so the probe
   * still has to pass. A standby that failed to come back is stopped here,
   * which leaves the next recovery attempt the cold start it would have done
   * all along.
   */
  it('stops a standby that answered but does not serve', async () => {
    const { root, daemon, oldContainerId } = await prepared();
    const deps = await standbyCutover(root, daemon, following());
    daemon.exitCodes.set('verity-managed-probe-rollback-old-g1', 1);
    await deps.quiesceOld(cutoverState(oldContainerId, 'quiescing-old'));

    await expect(
      deps.activateOld(cutoverState(oldContainerId, 'rollback-activating-old')),
    ).rejects.toThrow(/readiness probe \(rollback-old\) failed/);
    expect(daemon.status(MANAGED_SERVER_NAME)).toBe('exited');
  });

  /** End to end: a candidate that never serves gives the generation back to a
   *  process that never stopped serving requests it had already accepted. */
  it('rolls back onto the live standby', async () => {
    const { root, daemon, oldContainerId } = await prepared();
    daemon.exitCodes.set('verity-managed-probe-ready-g1', 1);
    const started = since(daemon.docker.startContainer);
    const stopped = since(daemon.docker.stopContainer);

    await expect(
      resumeUpdateCutover(await standbyCutover(root, daemon, following())),
    ).rejects.toThrow(/readiness probe \(ready\) failed/);

    expect(await readUpdateJournal(root)).toMatchObject({ phase: 'rolled-back' });
    expect(stopped()).not.toContain(oldContainerId);
    expect(started()).not.toContain(oldContainerId);
    expect(daemon.status(MANAGED_SERVER_NAME)).toBe('running');
    expect(daemon.names()).toEqual([MANAGED_SERVER_NAME]);
  });
});

/**
 * WHERE the control-plane PostgreSQL is reconciled (ADR 0008 D14).
 *
 * The whole safety argument is a position in the phase machine, and a position
 * is exactly the kind of thing a later refactor moves without noticing. These
 * pin it: the swap happens after the old Server has given up its pools and its
 * control-plane session, and before the candidate is activated and claims them.
 * Anywhere earlier and it runs under a live Server — which is the failure that
 * caused the outage this decision exists to prevent. Anywhere later and it runs
 * under the new one.
 */
describe('the control-plane PostgreSQL reconcile', () => {
  it('runs strictly inside the quiesce window', async () => {
    const { root, daemon } = await prepared();
    const order: string[] = [];
    const trace = <T>(name: string, inner: (value: T) => Promise<void>) => {
      return async (value: T): Promise<void> => {
        order.push(name);
        await inner(value);
      };
    };
    const deps = await dockerStandbyPromotion({
      managedRoot: root,
      docker: daemon.docker,
      environment: ENVIRONMENT,
      readinessTimeoutMs: 5_000,
      observeMs: 100,
      observeTimeoutMs: 5_000,
      sleep: async () => Promise.resolve(),
      activate: async () => Promise.resolve(),
      gateway: gatewayControl(daemon),
      reconcilePostgres: async () => {
        order.push('reconcile-postgres');
        return { kind: 'not-bundled' };
      },
    });
    await resumeUpdateCutover({
      ...deps,
      quiesceOld: trace('quiesce-old', deps.quiesceOld),
      activateCandidate: trace('activate-candidate', deps.activateCandidate),
    });
    expect(order).toEqual(['quiesce-old', 'reconcile-postgres', 'activate-candidate']);
  });

  it('does not touch the database for a release that names no pin', async () => {
    // The stock path: the fake daemon reports no image labels, so the reconcile
    // must fall out at its first read and leave every container alone. Without
    // that, every deployment updating from a release older than the label would
    // have its database inspected — and possibly recreated — on the strength of
    // a value that is not there.
    const { root, daemon } = await prepared();
    const replaced: string[] = [];
    daemon.docker.replaceContainerImage = async (id: string) => {
      replaced.push(id);
      return id;
    };
    await expect(resumeUpdateCutover(await cutover(root, daemon))).resolves.toMatchObject({
      phase: 'committed',
    });
    expect(replaced).toEqual([]);
  });
});
