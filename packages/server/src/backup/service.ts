import {
  maintainBackupGenerations,
  registerBackupGeneration,
  readBackupGenerations,
} from './generation-maintenance.js';
import { BackupOperationalAlerts, type BackupAlertNotifier } from './operational-alerts.js';
import { validateReadableIdentity } from './restore-identity.js';
import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { captureInstallation } from './capture.js';
import { BackupDestination, BackupSpaceError } from './destination.js';
import { readCaptureInventory, UNASSIGNED_BACKUP_SCOPE } from './inventory.js';
import { requestBackupIdentity } from './identity-request.js';
import { backupLifecycle } from './lifecycle.js';
import { readBackupCapabilities } from './prerequisites.js';
import { BackupRepository, readBounded } from './repository.js';
import { withRepositoryLock } from './repository-lock.js';
import {
  BackupRevocationJournal,
  syncRevocationOutbox,
  type BackupRevocationOutboxStore,
} from './revocations.js';
import {
  BackupScheduler,
  DEFAULT_BACKUP_INTERVAL_MS,
  backupScheduleAlerts,
  validateScheduleState,
} from './scheduler.js';
import { BackupSetup } from './setup.js';
import { BackupKeyReplacement, type ReplacementReason } from './key-replacement.js';
import { retireBackupIdentity } from './identity-request.js';
import { BackupStateStore, type BackupState } from './state.js';
import { BackupProbeJobs, probeVerificationAlerts, type ProbeJob } from './probe-jobs.js';
import { createProbeExecution, type ProbeRuntimeOptions } from './probe-runtime.js';

interface BackupServiceStore extends BackupRevocationOutboxStore {
  setBackupJournaling(enabled: boolean): Promise<void>;
  subscribeBackupRevocations(listener: () => Promise<void>): () => void;
  backupGitRepositoryKey(projectId: string | null, path: string): Promise<string>;
}
export interface BackupServiceOptions {
  probe?: ProbeRuntimeOptions;
  root: string;
  pairing: string;
  identityRoot: string;
  destination: string;
  identityRequests: string;
  image: string;
  release: string;
  schema: string;
  architecture: 'amd64' | 'arm64';
  /** Must use the dedicated installer-provisioned read-only role. */
  connect: () => Promise<PoolClient>;
  store: BackupServiceStore;
  onError: (error: unknown) => void;
}

/** Internal runtime composition. Routes remain gated until full fresh-host acceptance passes. */
export class BackupService {
  private alerts!: BackupOperationalAlerts;
  private probes: BackupProbeJobs | undefined;
  private readonly setup: BackupSetup;
  private readonly replacementSetup: BackupSetup;
  private readonly replacement: BackupKeyReplacement;
  private replacementReason: ReplacementReason | undefined;
  private readonly scheduler: BackupScheduler;
  private readonly shutdown = new AbortController();
  private active: Promise<unknown> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private healthActive: Promise<void> | undefined;
  private readonly unsubscribeRevocations: () => void;
  private revocationActive: Promise<void> | undefined;
  private revocationRequested = false;
  private constructor(
    private readonly options: BackupServiceOptions,
    private readonly state: BackupStateStore,
    private readonly destination: BackupDestination,
  ) {
    this.setup = new BackupSetup(async () => (await state.load()) !== undefined);
    this.replacementSetup = new BackupSetup(
      async () => (await state.load()) !== undefined,
      Date.now,
      true,
    );
    this.replacement = new BackupKeyReplacement(state);
    this.scheduler = new BackupScheduler({
      load: async () => (await this.configured()).schedule,
      update: async (change) =>
        (await state.update((current) => ({ ...current, schedule: change(current.schedule) })))
          .schedule,
      capture: async (signal) => {
        await this.capture(signal);
      },
      maintain: async () => {
        const current = await this.configured();
        try {
          await maintainBackupGenerations(
            this.state.root,
            this.destination,
            current,
            Date.now(),
            async () => !(await this.configured()).schedule.paused,
          );
          await this.alerts.maintenanceFailed(false);
        } catch (error) {
          await this.alerts.maintenanceFailed(true);
          throw error;
        }
      },
      syncRevocations: () => this.syncRevocations(),
    });
    this.unsubscribeRevocations = options.store.subscribeBackupRevocations(() =>
      this.syncRevocations(),
    );
  }
  private syncRevocations(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.revocationRequested = true;
    if (this.revocationActive) return this.revocationActive;
    const work = Promise.resolve().then(async () => {
      while (this.revocationRequested && !this.closed) {
        this.revocationRequested = false;
        const current = await this.state.load();
        if (!current) return;
        await this.options.store.setBackupJournaling(true);
        await registerBackupGeneration(this.state.root, current);
        const journals: BackupRevocationJournal[] = [];
        const seen = new Set<number>();
        for (const generation of await readBackupGenerations(
          this.state.root,
          current.installationId,
        )) {
          if (generation.targetId !== current.targetId)
            throw new Error('Invalid backup generation');
          if (seen.has(generation.keyGeneration)) continue;
          seen.add(generation.keyGeneration);
          journals.push(
            new BackupRevocationJournal(
              this.destination,
              join(this.state.root, `key-${generation.keyGeneration}`),
              generation.installationId,
              generation.keyGeneration,
              generation.host,
            ),
          );
        }
        await syncRevocationOutbox(
          this.options.store,
          {
            queue: async (id, event) => {
              for (const journal of journals) if (!(await journal.queue(id, event))) return false;
              return true;
            },
          },
          this.shutdown.signal,
        );
        for (const journal of journals) await journal.flush();
      }
    });
    this.revocationActive = work;
    void work
      .finally(() => {
        if (this.revocationActive === work) this.revocationActive = undefined;
      })
      .catch(this.options.onError);
    return work;
  }
  static async open(options: BackupServiceOptions): Promise<BackupService | undefined> {
    const capabilities = await readBackupCapabilities({
      pairing: options.pairing,
      destination: options.destination,
      identityRequests: options.identityRequests,
    });
    if (!capabilities.available || !capabilities.installationId || !capabilities.targetId)
      return undefined;
    const state = new BackupStateStore(
      join(options.root, 'backup-state'),
      capabilities.installationId,
    );
    const current = await state.load();
    if (current && current.targetId !== capabilities.targetId)
      throw new Error('Configured backup destination changed');
    const destination = await BackupDestination.open(options.destination, capabilities.targetId);
    const service = new BackupService(options, state, destination);
    try {
      service.alerts = await BackupOperationalAlerts.open(state.root);
      if (current) await service.run(() => service.resumeReplacement());
      if (current) await registerBackupGeneration(state.root, current);
      const probe = options.probe;
      if (probe)
        service.probes = await service.run(() =>
          BackupProbeJobs.open({
            root: state.root,
            installationId: state.installationId,
            exclusive: (action) => service.run(action),
            ...createProbeExecution(
              probe,
              state.root,
              async () => {
                await service.configured();
                await destination.assertPresent();
                return destination.pinnedPath() + '/.';
              },
              options.architecture,
            ),
            verified: async (result) => {
              await state.update((current) => ({
                ...current,
                lastProbe: {
                  repository: result.repository,
                  sequence: result.sequence,
                  finishedAt: Date.now(),
                },
              }));
            },
          }),
        );
      return service;
    } catch (error) {
      await service.close();
      throw error;
    }
  }
  private async configured(): Promise<BackupState> {
    const current = await this.state.load();
    if (!current) throw new Error('Backups are not configured');
    if (current.targetId !== this.destination.targetId) throw new Error('Backup target mismatch');
    return current;
  }
  private repository(current: BackupState): BackupRepository {
    return new BackupRepository(
      this.destination.path,
      this.state.root,
      `${current.installationId}-r${current.repositoryNumber}`,
      current.host,
      this.destination,
    );
  }
  private run<T>(action: () => T | Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Backup service is closed'));
    if (this.active) return Promise.reject(new Error('Backup operation is already in progress'));
    const work = Promise.resolve().then(async () => {
      await mkdir(this.state.root, { recursive: true, mode: 0o700 });
      return withRepositoryLock(join(this.state.root, 'operation.lock'), async () => action());
    });
    this.active = work;
    void work
      .finally(() => {
        if (this.active === work) this.active = undefined;
      })
      .catch(() => undefined);
    return work;
  }
  async beginSetup(): Promise<{ id: string; recoveryKey: string; expiresAt: number }> {
    return this.run(() => this.setup.begin());
  }
  async cancelSetup(): Promise<void> {
    return this.run(() => {
      this.setup.cancel();
    });
  }
  async confirmSetup(id: string, recoveryKey: string): Promise<void> {
    return this.run(() =>
      this.setup.confirm(id, recoveryKey, async (host) => {
        await mkdir(this.state.root, { recursive: true, mode: 0o700 });
        await withRepositoryLock(join(this.state.root, 'setup.lock'), async () => {
          if (await this.state.load()) throw new Error('Backups are already configured');
          await this.destination.assertWritable();
          let repositoryNumber = 1;
          // Failed setup may have published a header. Never reuse that repository or key generation.
          while (repositoryNumber <= 999999999) {
            try {
              await lstat(
                this.destination.repositoryPath(
                  `${this.state.installationId}-r${repositoryNumber}`,
                ),
              );
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
              throw error;
            }
            repositoryNumber++;
          }
          if (repositoryNumber > 999999999) throw new Error('Backup repository number exhausted');
          const current: BackupState = {
            format: 1,
            installationId: this.state.installationId,
            targetId: this.destination.targetId,
            keyGeneration: repositoryNumber,
            repositoryNumber,
            confirmedAt: Date.now(),
            host,
            lastProbe: null,
            schedule: {
              intervalMs: DEFAULT_BACKUP_INTERVAL_MS,
              paused: false,
              lastSuccess: null,
              lastAttempt: null,
              failures: 0,
            },
          };
          // Reserve the repository before requesting CA material. A crash leaves an orphan, never configured state.
          await this.repository(current).initialize();
          await registerBackupGeneration(this.state.root, current);
          await this.identity(current, this.shutdown.signal);
          await this.state.create(current);
          await this.options.store.setBackupJournaling(true);
        });
      }),
    );
  }
  async beginKeyReplacement(
    reason: ReplacementReason,
  ): Promise<{ id: string; recoveryKey: string; expiresAt: number }> {
    return this.run(async () => {
      if (reason !== 'lost' && reason !== 'exposed') throw new Error('Invalid replacement reason');
      const pending = await this.replacement.load();
      if (pending && !pending.complete) throw new Error('Confirmed replacement requires retry');
      const candidate = await this.replacementSetup.begin();
      this.replacementReason = reason;
      return candidate;
    });
  }
  async cancelKeyReplacement(): Promise<void> {
    return this.run(async () => {
      const pending = await this.replacement.load();
      if (pending && !pending.complete)
        throw new Error('Confirmed replacement cannot be cancelled');
      this.replacementSetup.cancel();
      this.replacementReason = undefined;
    });
  }
  async confirmKeyReplacement(id: string, recoveryKey: string): Promise<void> {
    return this.run(async () => {
      const pending = await this.replacement.load();
      if (pending?.id === id) {
        await this.resumeReplacement();
        return;
      }
      if (pending && !pending.complete) throw new Error('Confirmed replacement requires retry');
      await this.replacementSetup.confirm(id, recoveryKey, async (host) => {
        const previous = await this.configured();
        if (!this.replacementReason) throw new Error('Replacement reason missing');
        await this.destination.assertWritable();
        let number = Math.max(previous.repositoryNumber, previous.keyGeneration) + 1;
        for (; number <= 999999999; number++) {
          try {
            await lstat(this.destination.repositoryPath(`${previous.installationId}-r${number}`));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
            throw error;
          }
        }
        if (number > 999999999) throw new Error('Backup repository number exhausted');
        const next: BackupState = {
          ...previous,
          host,
          repositoryNumber: number,
          keyGeneration: number,
          confirmedAt: Date.now(),
          lastProbe: null,
          schedule: { ...previous.schedule, lastSuccess: null, lastAttempt: null, failures: 0 },
        };
        await this.replacement.save({
          format: 1,
          id,
          reason: this.replacementReason,
          previous,
          next,
          complete: false,
        });
        await this.resumeReplacement();
      });
    });
  }
  private async resumeReplacement(): Promise<void> {
    await this.replacement.resume({
      retire: (journal) =>
        retireBackupIdentity({
          requestRoot: this.options.identityRequests,
          destination: this.destination,
          installationId: journal.previous.installationId,
          retiredGeneration: journal.previous.keyGeneration,
          keyGeneration: journal.next.keyGeneration,
          recipient: journal.next.host.recipient,
          signal: this.shutdown.signal,
        }),
      publish: async (next) => {
        await this.repository(next).initialize(true);
        await registerBackupGeneration(this.state.root, next);
        await this.identity(next, this.shutdown.signal);
      },
    });
  }
  private async identity(current: BackupState, signal: AbortSignal): Promise<string> {
    return requestBackupIdentity({
      requestRoot: this.options.identityRequests,
      destination: this.destination,
      installationId: current.installationId,
      keyGeneration: current.keyGeneration,
      recipient: current.host.recipient,
      certificate: await readBounded(
        join(this.options.identityRoot, 'tls-ca-cert.pem'),
        1024 * 1024,
      ),
      signal,
    });
  }
  private async capture(signal: AbortSignal): Promise<void> {
    await this.resumeReplacement();
    const current = await this.configured();
    const combined = AbortSignal.any([signal, this.shutdown.signal]);
    await captureInstallation({
      root: this.options.root,
      identityRoot: this.options.identityRoot,
      caCiphertext: await this.identity(current, combined),
      installationId: current.installationId,
      keyGeneration: current.keyGeneration,
      image: this.options.image,
      release: this.options.release,
      schema: this.options.schema,
      architecture: this.options.architecture,
      kind: 'scheduled',
      onEstimate: (bytes) => this.alerts.estimate(bytes),
      connect: this.options.connect,
      repository: this.repository(current),
      lifecycle: backupLifecycle,
      destination: this.destination,
      inventory: (client) => readCaptureInventory(client, this.options.root, this.options.schema),
      repoKey: (projectId, path) =>
        this.options.store.backupGitRepositoryKey(
          projectId === UNASSIGNED_BACKUP_SCOPE ? null : projectId,
          path,
        ),
      signal: combined,
    });
  }
  async startProbe(recoveryKey: string): Promise<ProbeJob> {
    if (this.closed || !this.probes) throw new Error('Restore probe unavailable');
    return this.probes.start(recoveryKey);
  }
  probeStatus(id: string): ProbeJob | null {
    return this.probes?.status(id) ?? null;
  }
  async cancelProbe(id: string): Promise<ProbeJob> {
    if (this.closed || !this.probes) throw new Error('Restore probe unavailable');
    return this.probes.cancel(id);
  }
  async tick(): Promise<void> {
    if (!(await this.state.load())) return;
    return this.run(async () => {
      try {
        await this.resumeReplacement();
        await this.scheduler.tick();
      } finally {
        await this.health();
      }
    });
  }
  start(): void {
    if (this.closed) throw new Error('Backup service is closed');
    if (this.timer) return;
    const tick = (): void => {
      if (!this.active) void this.tick().catch(this.options.onError);
      else if (!this.closed) void this.health().catch(this.options.onError);
    };
    this.timer = setInterval(tick, 30000);
    this.timer.unref();
    tick();
  }
  async status(): Promise<{
    configured: boolean;
    paused?: boolean;
    intervalMs?: number;
    lastSuccess?: number | null;
    lastProbe?: BackupState['lastProbe'];
    probe?: ProbeJob | null;
    alerts: string[];
  }> {
    const current = await this.state.load();
    return current
      ? {
          configured: true,
          paused: current.schedule.paused,
          intervalMs: current.schedule.intervalMs,
          lastSuccess: current.schedule.lastSuccess,
          lastProbe: current.lastProbe,
          probe: this.probes?.status() ?? null,
          alerts: [
            ...backupScheduleAlerts(current.schedule, Date.now()),
            ...probeVerificationAlerts(current.confirmedAt, current.lastProbe, Date.now()),
            ...this.alerts
              .status()
              .filter(
                (code) => !['stale-backup', 'consecutive-failures', 'probe-overdue'].includes(code),
              ),
          ],
        }
      : { configured: false, alerts: [] };
  }

  setAlertNotifier(notify: BackupAlertNotifier): void {
    this.alerts.setNotifier(notify);
  }
  private health(): Promise<void> {
    if (this.healthActive) return this.healthActive;
    const work = this.refreshAlerts();
    this.healthActive = work;
    void work
      .finally(() => {
        if (this.healthActive === work) this.healthActive = undefined;
      })
      .catch(() => undefined);
    return work;
  }
  private async refreshAlerts(): Promise<void> {
    const current = await this.configured();
    const codes = [
      ...backupScheduleAlerts(current.schedule, Date.now()),
      ...probeVerificationAlerts(current.confirmedAt, current.lastProbe, Date.now()),
    ];
    let present = true;
    try {
      await this.destination.assertPresent();
    } catch {
      present = false;
      codes.push('destination-unavailable');
    }
    if (present) {
      try {
        const capacity = await this.destination.assertWritable(this.alerts.requiredBytes());
        if (capacity.nearlyFull) codes.push('insufficient-space');
        await this.destination.checkWritable();
      } catch (error) {
        codes.push(
          error instanceof BackupSpaceError ? 'insufficient-space' : 'destination-unwritable',
        );
      }
    }
    try {
      const files = new Map<string, Buffer>();
      for (const name of [
        'deployment-id',
        'pairing-identity.pem',
        'tls-key.pem',
        'tls-cert.pem',
        'tls-ca-cert.pem',
      ])
        files.set(name, await readBounded(join(this.options.identityRoot, name), 1024 * 1024));
      validateReadableIdentity(files);
    } catch {
      codes.push('identity-unreadable');
    }
    await this.alerts.refresh(codes);
  }
  async setPaused(paused: boolean): Promise<void> {
    await this.setPolicy({ paused });
  }
  async setPolicy(policy: { paused?: boolean; intervalMs?: number }): Promise<void> {
    if (this.closed) throw new Error('Backup service is closed');
    await this.state.update((current) => {
      const schedule = { ...current.schedule, ...policy };
      validateScheduleState(schedule);
      return { ...current, schedule };
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribeRevocations();
    if (this.timer) clearInterval(this.timer);
    this.shutdown.abort();
    this.probes?.abort();
    try {
      await Promise.allSettled([this.active, this.revocationActive, this.healthActive]);
    } finally {
      this.setup.cancel();
      this.replacementSetup.cancel();
      await this.destination.close();
    }
  }
}
