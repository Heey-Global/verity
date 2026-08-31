import { describe, expect, it } from 'vitest';
import { dockerUpdatePreparation } from './docker-update-preparation.js';
import { advanceManagedDeploymentImage, readManagedDeployment } from './managed-deployment.js';
import { MANAGED_SERVER_NAME, reconcileManagedServer } from './managed-server-owner.js';
import { createUpdateJournalCutoverStore } from './update-cutover.js';
import { beginUpdate, readUpdateJournal } from './update-journal.js';
import { resumeUpdatePreparation } from './update-preparation.js';
import {
  createOfficialImageVerifier,
  createUpdateRunner,
  recoverManagedUpdater,
  type UpdateRunnerDocker,
} from './update-runner.js';
import {
  adoptedDeployment,
  DEPLOYMENT_ID,
  ENVIRONMENT,
  newImage,
  oldImage,
  type FakeDaemon,
} from './managed-daemon.test-helper.js';

const journalled = (root: string, idempotencyKey = 'request-1') =>
  beginUpdate({
    root,
    deploymentId: DEPLOYMENT_ID,
    idempotencyKey,
    previousDigest: oldImage,
    targetDigest: newImage,
    currentGeneration: 0,
  });

const options = (root: string, daemon: FakeDaemon, log: string[] = []) => {
  const gateway = { maintenance: false, backend: MANAGED_SERVER_NAME };
  return {
    managedRoot: root,
    docker: daemon.docker,
    environment: ENVIRONMENT,
    cutover: {
      readinessTimeoutMs: 5_000,
      observeMs: 100,
      observeTimeoutMs: 5_000,
      sleep: async () => Promise.resolve(),
      activate: async () => Promise.resolve(),
      gateway: {
        status: async () => ({
          maintenance: gateway.maintenance,
          backend: { host: gateway.backend },
        }),
        enterMaintenance: async () => {
          gateway.maintenance = true;
        },
        leaveMaintenance: async () => {
          gateway.maintenance = false;
        },
        drain: async () => undefined,
        switchBackend: async (host: string) => {
          gateway.backend = host;
        },
      },
    },
    reconcileCompanions: async () => Promise.resolve(),
    log: (message: string) => log.push(message),
  };
};

const runner = (root: string, daemon: FakeDaemon, log: string[] = []) =>
  createUpdateRunner(options(root, daemon, log));

describe('update runner', () => {
  it('carries an accepted request through companion reconciliation to completion', async () => {
    const { root, daemon, oldContainerId } = await adoptedDeployment('update-runner');
    await journalled(root);

    await runner(root, daemon).run();

    expect(await readUpdateJournal(root)).toMatchObject({ phase: 'completed' });
    const state = await readManagedDeployment(root);
    expect(state.managed && state.spec.image).toBe(newImage);
    expect(daemon.spec('verity-managed-server-g1')?.image).toBe(newImage);
    expect(daemon.status('verity-managed-server-g1')).toBe('running');
    expect(daemon.names()).toEqual(['verity-managed-server-g1']);
    expect(daemon.find('verity-managed-server-g1')).not.toBe(oldContainerId);
  });

  // Preparation and cutover are one journal, and a restarted Updater enters
  // through the same call whatever phase it comes back to.
  it('resumes an operation a crash left prepared but not activated', async () => {
    const { root, daemon } = await adoptedDeployment('update-runner');
    await journalled(root);
    await resumeUpdatePreparation(
      root,
      await dockerUpdatePreparation({
        managedRoot: root,
        docker: daemon.docker,
        environment: ENVIRONMENT,
        verifyImage: async () => Promise.resolve(),
      }),
    );
    expect(await readUpdateJournal(root)).toMatchObject({ phase: 'standby' });

    const log: string[] = [];
    await runner(root, daemon, log).run();

    expect(log[0]).toMatch(/resuming at standby/);
    expect(await readUpdateJournal(root)).toMatchObject({ phase: 'completed' });
    expect(daemon.spec('verity-managed-server-g1')?.image).toBe(newImage);
    expect(daemon.names()).toEqual(['verity-managed-server-g1']);
  });

  it('leaves nothing behind and reports the outcome when preparation fails', async () => {
    const { root, daemon, oldContainerId } = await adoptedDeployment('update-runner');
    await journalled(root);
    daemon.exitCodes.set('verity-managed-preflight-g1', 3);
    daemon.logs.set('verity-managed-preflight-g1', 'schema generation is newer');
    const log: string[] = [];

    await runner(root, daemon, log).run();

    expect(await readUpdateJournal(root)).toMatchObject({
      phase: 'failed',
      failure: { code: 'preflight-failed' },
    });
    // The old generation never moved: preparation happens beside it.
    expect(daemon.find(MANAGED_SERVER_NAME)).toBe(oldContainerId);
    expect(daemon.status(MANAGED_SERVER_NAME)).toBe('running');
    const state = await readManagedDeployment(root);
    expect(state.managed && state.spec.image).toBe(oldImage);
    expect(log.join('\n')).toMatch(/failed/);
  });

  it('rolls back and stays on the previous digest when the new generation never serves', async () => {
    const { root, daemon } = await adoptedDeployment('update-runner');
    await journalled(root);
    daemon.exitCodes.set('verity-managed-probe-ready-g1', 1);

    await runner(root, daemon).run();

    expect(await readUpdateJournal(root)).toMatchObject({ phase: 'rolled-back' });
    const state = await readManagedDeployment(root);
    expect(state.managed && state.spec.image).toBe(oldImage);
    expect(daemon.spec(MANAGED_SERVER_NAME)?.image).toBe(oldImage);
    expect(daemon.status(MANAGED_SERVER_NAME)).toBe('running');
    expect(daemon.names()).toEqual([MANAGED_SERVER_NAME]);
  });

  it('does not touch a terminal or absent journal', async () => {
    const { root, daemon } = await adoptedDeployment('update-runner');
    await runner(root, daemon).run();
    expect(await readUpdateJournal(root)).toBeNull();
    expect(daemon.names()).toEqual([MANAGED_SERVER_NAME]);

    await journalled(root);
    await runner(root, daemon).run();
    const committed = await readUpdateJournal(root);
    await runner(root, daemon).run();
    expect(await readUpdateJournal(root)).toEqual(committed);
  });

  // The journal's single slot is guarded by a lease that refuses rather than
  // waits, so overlapping runs would fail for a reason unrelated to the update.
  it('serializes overlapping runs', async () => {
    const { root, daemon } = await adoptedDeployment('update-runner');
    await journalled(root);
    const one = runner(root, daemon);

    await Promise.all([one.run(), one.run(), one.run()]);

    expect(await readUpdateJournal(root)).toMatchObject({ phase: 'completed' });
    expect(daemon.names()).toEqual(['verity-managed-server-g1']);
  });

  /**
   * A failure while BUILDING the actions is not a journalled step, so nothing
   * else records it — and an operation stuck at `requested` would occupy the
   * single slot forever, answering every later request with a conflict.
   */
  it('records a failure that happens outside the journalled steps', async () => {
    const { root, daemon } = await adoptedDeployment('update-runner');
    await journalled(root);

    const crippled: UpdateRunnerDocker = { ...daemon.docker };
    delete crippled.inspectImageEnv;
    await createUpdateRunner({
      managedRoot: root,
      docker: crippled,
      environment: ENVIRONMENT,
      log: () => undefined,
    }).run();

    expect(await readUpdateJournal(root)).toMatchObject({
      phase: 'failed',
      failure: { code: 'requested-failed' },
    });
  });
});

/**
 * What a restarting Updater does, and in which order. Activation advances the
 * sealed image before it removes the old container, so a crash in that window is
 * the one state where reconciling first would be fatal.
 */
describe('updater startup recovery', () => {
  it('recreates the Gateway-selected promoted generation after Docker loses it', async () => {
    const { root, daemon } = await adoptedDeployment('update-runner-recovery');
    await journalled(root);
    const configured = options(root, daemon);
    await createUpdateRunner(configured).run();
    const lost = daemon.find('verity-managed-server-g1');
    expect(lost).toBeDefined();
    await daemon.docker.removeContainer(lost!);

    await recoverManagedUpdater(configured);

    expect(daemon.status('verity-managed-server-g1')).toBe('running');
    expect(daemon.find('verity-managed-server-g1')).not.toBe(lost);
    expect(daemon.names()).toEqual(['verity-managed-server-g1']);
  });

  it('reconciles the bootstrap Server after a terminal preparation failure', async () => {
    const { root, daemon, oldContainerId } = await adoptedDeployment('update-runner-recovery');
    await journalled(root);
    const crippled: UpdateRunnerDocker = { ...daemon.docker };
    delete crippled.inspectImageEnv;
    await createUpdateRunner({
      ...options(root, daemon),
      docker: crippled,
      log: () => undefined,
    }).run();
    expect(await readUpdateJournal(root)).toMatchObject({ phase: 'failed' });
    await daemon.docker.removeContainer(oldContainerId);

    await recoverManagedUpdater(options(root, daemon));

    expect(daemon.status(MANAGED_SERVER_NAME)).toBe('running');
  });

  /** Preparation done, sealed image advanced, standby disposed — and then the
   *  Updater dies before the old container is removed. */
  async function killedDuringActivation() {
    const { root, daemon, oldContainerId } = await adoptedDeployment('update-runner-recovery');
    await journalled(root);
    await resumeUpdatePreparation(
      root,
      await dockerUpdatePreparation({
        managedRoot: root,
        docker: daemon.docker,
        environment: ENVIRONMENT,
        verifyImage: async () => Promise.resolve(),
      }),
    );
    const store = createUpdateJournalCutoverStore(root, oldContainerId);
    await store.runExclusive(async () => {
      await store.transition('standby', 'quiescing-old');
      await store.transition('quiescing-old', 'handing-off-key');
      await store.transition('handing-off-key', 'activating-candidate');
    });
    await advanceManagedDeploymentImage({
      root,
      deploymentId: DEPLOYMENT_ID,
      fromImage: oldImage,
      toImage: newImage,
    });
    return { root, daemon, oldContainerId };
  }

  it('finishes the interrupted operation before reconciling the Server', async () => {
    const { root, daemon, oldContainerId } = await killedDuringActivation();
    // Why the order is load-bearing: reconciliation alone cannot recover this.
    await expect(
      reconcileManagedServer({
        managedRoot: root,
        docker: daemon.docker,
        environment: ENVIRONMENT,
      }),
    ).rejects.toThrow(/conflicts with the sealed deployment spec/);

    await recoverManagedUpdater(options(root, daemon));

    expect(await readUpdateJournal(root)).toMatchObject({ phase: 'completed' });
    expect(daemon.spec('verity-managed-server-g1')?.image).toBe(newImage);
    expect(daemon.status('verity-managed-server-g1')).toBe('running');
    expect(daemon.names()).toEqual(['verity-managed-server-g1']);
    expect(daemon.find('verity-managed-server-g1')).not.toBe(oldContainerId);
  });

  /**
   * A daemon that stays unhappy fails the resume and then the reconciliation
   * too. Exiting there would take the control boundary down with it and hide the
   * stalled operation from the device that has to decide what to do about it, so
   * the Updater comes up and says what it found instead.
   */
  it('comes up anyway when neither the operation nor reconciliation can finish', async () => {
    const { root, daemon } = await killedDuringActivation();
    const broken: UpdateRunnerDocker = {
      ...daemon.docker,
      createContainer: async () => Promise.reject(new Error('daemon is unhappy')),
    };
    const log: string[] = [];

    await expect(
      recoverManagedUpdater({ ...options(root, daemon, log), docker: broken }),
    ).resolves.toBeDefined();

    const journal = await readUpdateJournal(root);
    expect(journal?.phase).not.toBe('committed');
    expect(journal?.phase).not.toBe('rolled-back');
    expect(daemon.status(MANAGED_SERVER_NAME)).toBe('running');
  });

  /** Without an operation to own the outcome, a broken daemon is simply a broken
   *  Updater — exiting hands the retry to the restart policy. */
  it('fails to start when reconciliation fails and nothing is in flight', async () => {
    const { root, daemon, oldContainerId } = await adoptedDeployment('update-runner-recovery');
    await daemon.docker.removeContainer(oldContainerId);
    const broken: UpdateRunnerDocker = {
      ...daemon.docker,
      createContainer: async () => Promise.reject(new Error('daemon is unhappy')),
    };

    await expect(
      recoverManagedUpdater({ ...options(root, daemon), docker: broken }),
    ).rejects.toThrow(/daemon is unhappy/);
  });

  it('still reconciles a stopped Server when the journal has nothing to finish', async () => {
    const { root, daemon, oldContainerId } = await adoptedDeployment('update-runner-recovery');
    await daemon.docker.stopContainer(oldContainerId);

    await recoverManagedUpdater(options(root, daemon));

    expect(await readUpdateJournal(root)).toBeNull();
    expect(daemon.status(MANAGED_SERVER_NAME)).toBe('running');
    expect(daemon.find(MANAGED_SERVER_NAME)).toBe(oldContainerId);
  });
});

describe('updater-side image attestation', () => {
  const journal = (targetDigest: string) => ({ targetDigest }) as never;

  it('accepts an official digest whose image declares a released version', async () => {
    const { daemon } = await adoptedDeployment('update-runner-verify');
    await expect(
      createOfficialImageVerifier(daemon.docker)(journal(newImage)),
    ).resolves.toBeUndefined();
  });

  it('refuses an image outside the official Server repository', async () => {
    const { daemon } = await adoptedDeployment('update-runner-verify');
    await expect(
      createOfficialImageVerifier(daemon.docker)(
        journal(`ghcr.io/attacker/verity-server@sha256:${'c'.repeat(64)}`),
      ),
    ).rejects.toThrow(/not an official Verity Server digest/);
  });

  it('refuses an image that is not a published Verity Server build', async () => {
    for (const environment of [[], ['VERITY_SERVER_VERSION=0.0.0-dev']])
      await expect(
        createOfficialImageVerifier({
          inspectImageEnv: async () => Promise.resolve(environment),
        })(journal(newImage)),
      ).rejects.toThrow(/does not declare a released Verity Server version/);
  });
});
