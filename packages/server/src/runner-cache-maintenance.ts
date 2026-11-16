import { isCacheHelper, retainLatestCacheHelper } from './cache-helper-retention.js';
import { randomUUID } from 'node:crypto';
import { posix, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { RunnerTurnOwnershipRequest } from '@verity/store';
import type { DockerClient } from './docker.js';
import {
  cacheHelperCommand,
  cacheHelperFailureReason,
  cacheMaintenanceResponse,
} from './runner-cache-helper.js';
import type { cacheHelperDiagnostic } from './runner-cache-helper.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const turn = z.object({
  turnId: id,
  startCommandId: id.optional(),
  runnerInstanceId: id.optional(),
});
const pending = z.object({
  ok: z.literal(true),
  maintenancePending: z.literal(true),
  scanId: id,
  cursor: z.string().max(256),
  turnsNeedingOwnership: z.array(turn).max(256),
});
export type CacheTurnOwner = { turnId: string; sessionId?: string; conflict: boolean };
export function cacheMaintenanceFailure(
  code: string,
  diagnostics?: {
    exitCode?: number;
    phase?: 'create' | 'start' | 'wait' | 'inspect' | 'logs' | 'response';
    memoryBytes?: number;
    pidsLimit?: number;
    /** Absent only when the helper's logs could not be read. */
    outputBytes?: number;
    reason?: z.infer<typeof cacheHelperDiagnostic>;
  },
): Error {
  return Object.assign(new Error('Runner cache maintenance is unavailable'), {
    runnerCacheFailure: { code, ...diagnostics },
  });
}
function incompleteReport() {
  return {
    ok: true,
    maintenancePending: true,
    report: {
      observedAt: new Date().toISOString(),
      sharedBytes: null,
      legacyBytes: null,
      removedBytes: 0,
      legacyCachesRemoved: 0,
      sharedCachePruned: false,
      usageComplete: false,
      blockers: ['Runner cache maintenance inventory is incomplete'],
    },
  };
}

/** Continuations are scoped to an authenticated runtime and exact requested session set. */
export class RunnerCacheMaintenance {
  private readonly scans = new Map<
    string,
    { key: string; scanId: string; turnOwners: CacheTurnOwner[]; expires: number }
  >();
  constructor(
    private readonly deps: {
      request: (
        projectId: string,
        request: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
      resolveOwners: (input: {
        sessionIds: string[];
        turns: RunnerTurnOwnershipRequest[];
      }) => Promise<CacheTurnOwner[]>;
      offline: (projectId: string, sessionIds: string[], maxBytes: number) => Promise<unknown>;
      now?: () => number;
    },
  ) {}

  async request(projectId: string, sessionIds: string[], maxBytes: number): Promise<unknown> {
    const now = this.deps.now ?? Date.now;
    for (const [runtime, scan] of this.scans) if (scan.expires <= now()) this.scans.delete(runtime);
    if (this.scans.size >= 1000 && !this.scans.has(projectId))
      this.scans.delete(this.scans.keys().next().value!);
    const key = JSON.stringify([sessionIds, maxBytes]);
    let status: Record<string, unknown>;
    try {
      status = await this.deps.request(projectId, { kind: 'status' });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error;
      this.scans.delete(projectId);
      // The offline implementation independently proves lifecycle exclusion.
      return this.deps.offline(projectId, sessionIds, maxBytes);
    }
    if (status.cacheMaintenanceVersion !== 2 || status.turnOwnershipVersion !== 1)
      throw cacheMaintenanceFailure('unsupported');
    const deadline = now() + 5000;
    for (;;) {
      const saved = this.scans.get(projectId);
      const continuation = saved?.key === key && saved.expires > now() ? saved : undefined;
      let response: Record<string, unknown>;
      try {
        response = await this.deps.request(projectId, {
          kind: 'reclaim-package-caches',
          maintenanceVersion: 2,
          sessionIds,
          maxBytes,
          ...(continuation === undefined
            ? {}
            : { scanId: continuation.scanId, turnOwners: continuation.turnOwners }),
        });
      } catch (error) {
        this.scans.delete(projectId);
        throw error;
      }
      if (response.maintenancePending !== true) {
        this.scans.delete(projectId);
        return response;
      }
      const page = pending.parse(response);
      const owners = await this.deps.resolveOwners({
        sessionIds,
        turns: page.turnsNeedingOwnership.map((value) => ({
          turnId: value.turnId,
          ...(value.startCommandId === undefined ? {} : { startCommandId: value.startCommandId }),
          ...(value.runnerInstanceId === undefined
            ? {}
            : { runnerInstanceId: value.runnerInstanceId }),
        })),
      });
      // Never forward an unbound or duplicate database result as supervisor authority.
      const expected = new Set(page.turnsNeedingOwnership.map((item) => item.turnId));
      if (
        owners.length !== expected.size ||
        new Set(owners.map((item) => item.turnId)).size !== expected.size ||
        owners.some((item) => !expected.has(item.turnId))
      )
        throw cacheMaintenanceFailure('invalid-response');
      this.scans.set(projectId, {
        key,
        scanId: page.scanId,
        turnOwners: owners,
        expires: now() + 240_000,
      });
      if (now() >= deadline) return incompleteReport();
    }
  }
}

function volumeSubpathsOverlap(subpath: string | undefined, target: string): boolean {
  if (subpath === undefined || subpath === '') return true;
  // Malformed or platform-ambiguous inventory cannot prove independent storage.
  if (posix.isAbsolute(subpath) || subpath.includes('\\') || subpath.split('/').includes('..'))
    return true;
  const path = posix.normalize(subpath).replace(/\/$/u, '');
  return (
    path === '.' ||
    path === target ||
    path.startsWith(`${target}/`) ||
    target.startsWith(`${path}/`)
  );
}

/** The helper runs under the project runtime (gVisor). Docker charges the
 * runtime's own host threads to the pids limit and its memory to the cgroup.
 * Helpers limited to 32 pids and 256 MiB were observed failing before Node
 * started ("exec timeout failed: Cannot allocate memory"), which leaves the
 * caches unreclaimed. These bounds match other long-lived helper containers and
 * remain far below a project sandbox; `resource-unavailable` diagnostics report
 * the bounds in force, so a recurrence remains distinguishable. */
export const CACHE_HELPER_RESOURCES = { memoryBytes: 512 * 1024 ** 2, pidsLimit: 128 } as const;

/** Called only inside the project lifecycle/storage barriers; it never starts a project. */
export async function reclaimSleepingRunnerCaches(input: {
  docker: DockerClient;
  projectId: string;
  runtimeRoot: string;
  image: string;
  runtime: string;
  serverContainerId: string;
  runtimeGid?: number;
  dataVolume?: { name: string; root: string };
  sessionIds: string[];
  maxBytes: number;
  assertIdle: () => Promise<void>;
}): Promise<unknown> {
  const { docker } = input;
  if (
    !docker.listContainers ||
    !docker.waitContainer ||
    !docker.containerLogs ||
    !docker.removeStoppedContainer
  )
    throw cacheMaintenanceFailure('unsupported');
  const removeStoppedContainer = docker.removeStoppedContainer.bind(docker);
  if (
    !id.safeParse(input.projectId).success ||
    !/^(?:sha256:[a-f0-9]{64}|.+@sha256:[a-f0-9]{64})$/u.test(input.image)
  )
    throw cacheMaintenanceFailure('unsupported');
  await input.assertIdle();
  const runtimeRoot = resolve(input.runtimeRoot);
  const self = await docker.inspectContainer(input.serverContainerId);
  if (self.id !== input.serverContainerId || self.mounts === undefined)
    throw cacheMaintenanceFailure('runtime-not-idle');
  // Engine bind sources use host paths, while runtimeRoot is inside the Server.
  // Translate through our own mount inventory so physical bind aliases cannot
  // hide a writer of the same data behind a different path spelling.
  const runtimeAliases = [runtimeRoot];
  const coveringMounts = self.mounts
    .filter(
      (mount) =>
        mount.destination &&
        (runtimeRoot === resolve(mount.destination) ||
          runtimeRoot.startsWith(`${resolve(mount.destination)}/`)),
    )
    .sort((a, b) => resolve(b.destination!).length - resolve(a.destination!).length);
  const runtimeMount = coveringMounts[0];
  const hostRuntimeRoot =
    runtimeMount?.source && !runtimeMount.subpath
      ? resolve(runtimeMount.source, relative(resolve(runtimeMount.destination!), runtimeRoot))
      : undefined;
  if (!input.dataVolume && !hostRuntimeRoot) throw cacheMaintenanceFailure('runtime-not-idle');
  for (const mount of self.mounts) {
    if (!mount.source || !mount.destination || mount.subpath) continue;
    const destination = resolve(mount.destination);
    if (runtimeRoot === destination || runtimeRoot.startsWith(`${destination}/`))
      runtimeAliases.push(resolve(mount.source, relative(destination, runtimeRoot)));
  }
  const retention = await retainLatestCacheHelper({ docker, projectId: input.projectId }).catch(
    () => {
      throw cacheMaintenanceFailure('maintenance-helper-retention-blocked');
    },
  );
  if (retention.blocked) throw cacheMaintenanceFailure('maintenance-helper-retention-blocked');
  const consumers = await docker.listContainers();
  if (consumers.length > 1000) throw cacheMaintenanceFailure('runtime-not-idle');
  const inventoryDeadline = Date.now() + 5000;
  // Inspect every container: a missing project label must not hide a runtime bind.
  for (const candidate of consumers) {
    if (Date.now() >= inventoryDeadline) throw cacheMaintenanceFailure('runtime-not-idle');
    const inspect = await docker.inspectContainer(candidate.id);
    if (inspect.id === input.serverContainerId) continue;
    if (inspect.mounts === undefined) throw cacheMaintenanceFailure('runtime-not-idle');
    const hasRuntime = inspect.mounts?.some((mount) => {
      if (input.dataVolume !== undefined && mount.name === input.dataVolume.name)
        return volumeSubpathsOverlap(mount.subpath, `runners/${input.projectId}`);
      if (
        mount.source &&
        runtimeAliases.some(
          (path) =>
            resolve(mount.source!) === path ||
            path.startsWith(`${resolve(mount.source!)}/`) ||
            resolve(mount.source!).startsWith(`${path}/`),
        )
      )
        return true;
      return false;
    });
    if (!hasRuntime && inspect.labels?.['verity.project-id'] !== input.projectId) continue;
    if (
      hasRuntime &&
      !inspect.running &&
      ['created', 'exited', 'dead'].includes(inspect.status ?? '') &&
      isCacheHelper(candidate, input.projectId) &&
      inspect.labels?.['verity.project-id'] === input.projectId &&
      inspect.labels?.['verity.component'] === 'runner-cache-maintenance'
    ) {
      // The retention pass already reconciled these under the same barriers.
      continue;
    }
    if (inspect.running || !['exited', 'dead'].includes(inspect.status ?? ''))
      throw cacheMaintenanceFailure('runtime-not-idle');
  }
  await input.assertIdle();
  const name = `verity-cache-maintenance-${randomUUID()}`;
  const request = JSON.stringify({ sessionIds: input.sessionIds, maxBytes: input.maxBytes });
  if (Buffer.byteLength(request) > 96 * 1024) throw cacheMaintenanceFailure('invalid-response');
  const resources = { ...CACHE_HELPER_RESOURCES };
  let phase: 'create' | 'start' | 'wait' | 'inspect' | 'logs' | 'response' = 'create';
  const created = await docker
    .createContainer({
      name,
      image: input.image,
      entrypoint: ['timeout', '--kill-after=5s', '25s', 'node'],
      command: ['-e', cacheHelperCommand],
      env: [
        'VERITY_RUNNER_RUNTIME=/run/verity-runner',
        'VERITY_RUNNER_RUNTIME_UID=1101',
        `VERITY_RUNNER_RUNTIME_GID=${input.runtimeGid ?? 1101}`,
        'VERITY_AGENT_UID=1000',
        'VERITY_AGENT_GID=1000',
        `VERITY_CACHE_MAINTENANCE_REQUEST=${request}`,
      ],
      ...(input.dataVolume
        ? {
            volumeMounts: [
              {
                volume: input.dataVolume.name,
                subpath: `runners/${input.projectId}`,
                target: '/run/verity-runner',
              },
            ],
          }
        : { binds: [`${hostRuntimeRoot!}:/run/verity-runner`] }),
      labels: {
        'verity.project-id': input.projectId,
        'verity.component': 'runner-cache-maintenance',
      },
      user: `0:${input.runtimeGid ?? 1101}`,
      runtime: input.runtime,
      network: 'none',
      restartPolicy: 'no',
      readOnlyRootfs: true,
      capDrop: ['ALL'],
      capAdd: ['CHOWN', 'SETUID', 'SETGID'],
      securityOpt: ['no-new-privileges=true'],
      ...resources,
      memorySwapBytes: CACHE_HELPER_RESOURCES.memoryBytes,
      nanoCpus: 1_000_000_000,
      tmpfs: { '/tmp': 'rw,nosuid,nodev,size=16m' },
    })
    .catch(() => {
      throw cacheMaintenanceFailure('maintenance-helper-failed', { phase, ...resources });
    });
  let stopped = false;
  let exitCode: number | undefined;
  let failed = false;
  let primaryError: unknown;
  const cleanup = async () => {
    try {
      if (failed) {
        const retention = await retainLatestCacheHelper({ docker, projectId: input.projectId });
        if (retention.blocked)
          throw cacheMaintenanceFailure('maintenance-helper-retention-blocked');
      } else if (stopped) {
        await removeStoppedContainer(created.id);
      }
    } catch (cleanupError) {
      if (!failed) throw cleanupError;
      throw Object.assign(
        new AggregateError(
          [primaryError, cleanupError],
          'Runner cache maintenance and cleanup failed',
        ),
        {
          ...(typeof primaryError === 'object' && primaryError !== null ? primaryError : {}),
          runnerCacheCleanupFailed: true,
        },
      );
    }
  };
  try {
    phase = 'start';
    await docker.startContainer(created.id);
    phase = 'wait';
    const exit = await docker.waitContainer(created.id, { timeoutMs: 30_000 });
    exitCode = exit;
    phase = 'inspect';
    const inspect = await docker.inspectContainer(created.id);
    stopped =
      inspect.id === created.id &&
      !inspect.running &&
      ['exited', 'dead'].includes(inspect.status ?? '') &&
      inspect.imageId === input.image &&
      inspect.labels?.['verity.project-id'] === input.projectId &&
      inspect.labels?.['verity.component'] === 'runner-cache-maintenance';
    if (!stopped) throw cacheMaintenanceFailure('maintenance-helper-failed');
    phase = 'logs';
    const logs = await docker.containerLogs(created.id, 1).then(
      (output) => ({ output }),
      (error: unknown) => ({ error }),
    );
    // The exit code alone classifies an unsupported image; a failed log read must not hide it.
    if (exit === 78)
      throw cacheMaintenanceFailure(
        'unsupported',
        'output' in logs
          ? {
              exitCode: exit,
              outputBytes: Buffer.byteLength(logs.output),
              reason: cacheHelperFailureReason(logs.output, exit),
            }
          : { exitCode: exit },
      );
    if ('error' in logs) throw logs.error;
    const output = logs.output;
    const diagnostics = {
      exitCode: exit,
      outputBytes: Buffer.byteLength(output),
      reason: cacheHelperFailureReason(output, exit),
    };
    phase = 'response';
    if (inspect.exitCode !== 0 || exit !== 0)
      throw cacheMaintenanceFailure('maintenance-helper-failed', diagnostics);
    if (diagnostics.outputBytes > 64 * 1024)
      throw cacheMaintenanceFailure('invalid-response', diagnostics);
    try {
      return cacheMaintenanceResponse.parse(JSON.parse(output));
    } catch {
      throw cacheMaintenanceFailure('invalid-response', diagnostics);
    }
  } catch (error) {
    failed = true;
    const classified = typeof error === 'object' && error !== null && 'runnerCacheFailure' in error;
    primaryError = classified ? error : cacheMaintenanceFailure('maintenance-helper-failed');
    const failure = primaryError as Error & { runnerCacheFailure: object };
    failure.runnerCacheFailure = {
      ...failure.runnerCacheFailure,
      ...(exitCode === undefined ? {} : { exitCode }),
      phase,
      ...resources,
    };
    throw primaryError;
  } finally {
    await cleanup();
  }
}
