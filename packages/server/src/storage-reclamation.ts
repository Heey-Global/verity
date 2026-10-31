import { nativeRetirementSchema, type StorageReclamationAction } from '@verity/events';
import { readFile, realpath, rename, statfs, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DockerGcReport } from './docker-gc.js';
import type { SessionStorageReport } from './session-storage.js';

export class StorageReclamation {
  private flight: Promise<void> | undefined;
  private nativeRequestedAt: string | null = null;
  private value: StorageReclamationAction = {
    supported: true,
    state: 'idle',
    startedAt: null,
    completedAt: null,
    error: null,
    result: null,
    nativePending: false,
    nativeBuildkit: null,
  };
  constructor(
    private readonly deps: {
      collect: () => Promise<DockerGcReport>;
      worktrees: () => SessionStorageReport | undefined;
      directory?: string | undefined;
      dataRoot?: string | undefined;
    },
  ) {}
  async status(): Promise<StorageReclamationAction> {
    const nativeBuildkit = await readNativeReclamation(this.deps.directory);
    this.value.nativePending =
      this.value.nativePending &&
      (!nativeBuildkit ||
        nativeBuildkit.blockers.some((b) => b.includes('receipt is')) ||
        Date.parse(nativeBuildkit.observedAt) < Date.parse(this.nativeRequestedAt!));
    return { ...this.value, nativeBuildkit };
  }
  async start(): Promise<void> {
    await this.status();
    if (this.flight) return;
    this.value = {
      ...this.value,
      state: 'running',
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
      result: null,
      nativePending: false,
    };
    this.flight = this.run()
      .catch(() => {
        this.value = {
          ...this.value,
          state: 'failed',
          error: 'Storage reclamation failed; inspect server diagnostics.',
          completedAt: new Date().toISOString(),
        };
      })
      .finally(() => {
        this.flight = undefined;
      });
  }
  private async available(): Promise<number | null> {
    if (!this.deps.dataRoot) return null;
    try {
      const s = await statfs(this.deps.dataRoot);
      return s.bavail * s.bsize;
    } catch {
      return null;
    }
  }
  private async run(): Promise<void> {
    const before = await this.available();
    // The scheduler owns the shared single-flight for manual, admission and scheduled passes.
    const report = await this.deps.collect();
    const worktrees = this.deps.worktrees();
    const after = await this.available();
    const blockers = report.errors.map((e) => `${e.resource}: ${e.message}`);
    blockers.push(...(worktrees?.blockers.map((e) => e.reason) ?? []));
    let nativePending = false;
    try {
      // A manual request may join an older scheduled pass. Correlate against
      // that pass's actual host request, not the later UI action start time.
      this.nativeRequestedAt =
        report.nativeRequestedAt === undefined
          ? await requestNativeReclamation(this.deps.directory)
          : report.nativeRequestedAt;
      if (this.nativeRequestedAt === null) throw new Error('Native host request failed');
      nativePending = true;
    } catch {
      blockers.push(
        'Native BuildKit host maintenance is unavailable; install the matching host component.',
      );
    }
    this.value = {
      ...this.value,
      state: 'completed',
      completedAt: new Date().toISOString(),
      nativePending,
      result: {
        imagesRemoved: report.imagesRemoved.length,
        containersRemoved: report.containersRemoved.length,
        dependenciesRemoved: worktrees?.dependenciesRemoved.length ?? 0,
        worktreesRetired: worktrees?.worktreesRetired.length ?? 0,
        filesystemFreeBytesChange: before === null || after === null ? null : after - before,
        retainedPins: report.keptImageReasons.map((pin) => ({
          ...pin,
          reason: pin.containers
            .map(
              (name) =>
                `${name}: ${report.retainedContainers?.find((c) => c.name === name)?.reason ?? 'Container reference retained; state changed or ownership could not be verified'}`,
            )
            .join('; '),
        })),
        blockers,
      },
    };
  }
}

/** A fixed request file queues work for the existing root-owned timer; its contents are never commands. */
export async function requestNativeReclamation(
  directory = '/run/verity-buildkit',
): Promise<string> {
  const evidence = join(directory, 'reclamation-evidence');
  if ((await realpath(evidence)) !== evidence) throw new Error('Unsafe evidence directory');
  const temp = join(evidence, `request-${randomUUID()}.tmp`);
  const requestedAt = new Date().toISOString();
  await writeFile(temp, JSON.stringify({ version: 1, requestedAt }), { flag: 'wx', mode: 0o600 });
  await rename(temp, join(evidence, 'request.json'));
  return requestedAt;
}

/** Receipt visibility is separate from deletion authority; missing evidence never means zero bytes. */
export async function readNativeReclamation(
  directory = '/run/verity-buildkit',
  now = Date.now(),
): Promise<ReturnType<typeof nativeRetirementSchema.parse>> {
  try {
    const value = nativeRetirementSchema.parse(
      JSON.parse(await readFile(join(directory, 'native-retirement.json'), 'utf8')),
    );
    const age = now - Date.parse(value.observedAt);
    if (age < 0 || (value.state !== 'completed' && age >= 120_000))
      return {
        ...value,
        state: 'blocked',
        eligible: false,
        blockers: [
          ...value.blockers.slice(0, 99),
          'Native host receipt is stale or future-dated; verify the matching host helper and timer.',
        ],
      };
    return value;
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      version: 1,
      observedAt: new Date(0).toISOString(),
      path: '/var/lib/verity-buildkit/runc-native',
      dryRun: true,
      eligible: false,
      state: 'blocked',
      allocatedBytes: null,
      overlayAllocatedBytes: null,
      reclaimableBytes: null,
      blockers: [
        missing
          ? 'Native host receipt is missing; helper installation or execution is unverified. Check the host helper, timer and server receipt mount.'
          : 'Native host receipt is unreadable or invalid; check host helper compatibility and receipt permissions.',
      ],
    };
  }
}
