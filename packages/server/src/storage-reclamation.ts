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
    supported: true, state: 'idle', startedAt: null, completedAt: null, error: null,
    result: null, nativePending: false, nativeBuildkit: null,
  };
  constructor(private readonly deps: {
    collect: () => Promise<DockerGcReport>;
    worktrees: () => SessionStorageReport | undefined;
    directory?: string | undefined;
    dataRoot?: string | undefined;
  }) {}
  async status(): Promise<StorageReclamationAction> {
    let nativeBuildkit = null;
    try {
      nativeBuildkit = nativeRetirementSchema.parse(JSON.parse(await readFile(join(this.deps.directory ?? '/run/verity-buildkit', 'native-retirement.json'), 'utf8')));
    } catch { /* Missing host receipts remain unknown. */ }
    this.value.nativePending = this.value.nativePending && (!nativeBuildkit || Date.parse(nativeBuildkit.observedAt) < Date.parse(this.nativeRequestedAt!));
    return { ...this.value, nativeBuildkit };
  }
  async start(): Promise<void> {
    await this.status();
    if (this.flight) return;
    this.value = { ...this.value, state: 'running', startedAt: new Date().toISOString(), completedAt: null, error: null, result: null, nativePending: false };
    this.flight = this.run().catch(() => {
      this.value = { ...this.value, state: 'failed', error: 'Storage reclamation failed; inspect server diagnostics.', completedAt: new Date().toISOString() };
    }).finally(() => { this.flight = undefined; });
  }
  private async available(): Promise<number | null> {
    if (!this.deps.dataRoot) return null;
    try { const s = await statfs(this.deps.dataRoot); return s.bavail * s.bsize; } catch { return null; }
  }
  private async run(): Promise<void> {
    const before = await this.available();
    // The scheduler owns the shared single-flight for manual, admission and scheduled passes.
    const report = await this.deps.collect();
    const worktrees = this.deps.worktrees();
    const after = await this.available();
    const blockers = report.errors.map(e => `${e.resource}: ${e.message}`);
    blockers.push(...(worktrees?.blockers.map(e => e.reason) ?? []));
    let nativePending = false;
    try {
      // A manual request may join an older scheduled pass. Correlate against
      // that pass's actual host request, not the later UI action start time.
      this.nativeRequestedAt = report.nativeRequestedAt === undefined
        ? await requestNativeReclamation(this.deps.directory)
        : report.nativeRequestedAt;
      if (this.nativeRequestedAt === null) throw new Error('Native host request failed');
      nativePending = true;
    } catch { blockers.push('Native BuildKit host maintenance is unavailable; install the matching host component.'); }
    this.value = { ...this.value, state: 'completed', completedAt: new Date().toISOString(), nativePending,
      result: {
        imagesRemoved: report.imagesRemoved.length, containersRemoved: report.containersRemoved.length,
        dependenciesRemoved: worktrees?.dependenciesRemoved.length ?? 0, worktreesRetired: worktrees?.worktreesRetired.length ?? 0,
        filesystemFreeBytesChange: before === null || after === null ? null : after - before,
        retainedPins: report.keptImageReasons.map(pin => ({ ...pin, reason: pin.containers.map(name => `${name}: ${report.retainedContainers?.find(c => c.name === name)?.reason ?? 'Container reference retained; state changed or ownership could not be verified'}`).join('; ') })),
        blockers,
      },
    };
  }
}

/** A fixed request file wakes the root-owned path unit; its contents are never commands. */
export async function requestNativeReclamation(directory = '/run/verity-buildkit'): Promise<string> {
  const evidence = join(directory, 'reclamation-evidence');
  if (await realpath(evidence) !== evidence) throw new Error('Unsafe evidence directory');
  const temp = join(evidence, `request-${randomUUID()}.tmp`);
  const requestedAt = new Date().toISOString();
  await writeFile(temp, JSON.stringify({ version: 1, requestedAt }), { flag: 'wx', mode: 0o600 });
  await rename(temp, join(evidence, 'request.json'));
  return requestedAt;
}
