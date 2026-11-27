import { readFile, statfs } from 'node:fs/promises';
import { cpus, freemem, totalmem } from 'node:os';
import type { FastifyInstance } from 'fastify';

/**
 * CPU, memory and disk of the host the Server runs on, as one glance.
 *
 * Inside a container `/proc/stat` and `/proc/meminfo` describe the whole host,
 * not the container, which is what an operator watching for a full disk or a
 * saturated machine wants. Network traffic is not reported: `/proc/net/dev`
 * is namespaced, so the Server could only count its own container's traffic.
 */
export interface HostResources {
  observedAt: string;
  /** Busy share of all cores since the previous sample, 0–100; null when no
   *  interval could be measured. */
  cpu: { percent: number | null; cores: number };
  memory: { usedBytes: number; totalBytes: number };
  /** The disk holding the Server's data; null without a data root. */
  disk: { usedBytes: number; totalBytes: number } | null;
}

interface CpuTimes {
  busy: number;
  total: number;
}

export function parseCpuTimes(procStat: string): CpuTimes | undefined {
  const line = procStat.split('\n').find((entry) => entry.startsWith('cpu '));
  if (line === undefined) return undefined;
  const fields = line.trim().split(/\s+/u).slice(1, 9).map(Number);
  if (fields.length < 4 || fields.some((value) => !Number.isFinite(value))) return undefined;
  const total = fields.reduce((sum, value) => sum + value, 0);
  // idle + iowait: time no core spent working.
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
  return { busy: total - idle, total };
}

export function parseMemory(
  meminfo: string,
): { usedBytes: number; totalBytes: number } | undefined {
  const kib = (name: string) => {
    const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, 'mu').exec(meminfo);
    return match ? Number(match[1]) * 1024 : undefined;
  };
  const total = kib('MemTotal');
  // MemAvailable counts reclaimable cache as free, as the kernel would hand it out.
  const available = kib('MemAvailable');
  if (total === undefined || available === undefined) return undefined;
  return { usedBytes: Math.max(0, total - available), totalBytes: total };
}

export function createHostResourcesSampler(
  options: {
    dataRoot?: string | undefined;
    readProcFile?: (path: string) => Promise<string>;
    measureDisk?: (path: string) => Promise<{ usedBytes: number; totalBytes: number }>;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
  } = {},
) {
  const read = options.readProcFile ?? ((path: string) => readFile(path, 'utf8'));
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const measureDisk =
    options.measureDisk ??
    (async (path: string) => {
      const stats = await statfs(path);
      const totalBytes = stats.blocks * stats.bsize;
      // `df`'s Used column: blocks in use. `bavail` would also count the free
      // blocks reserved for root as used.
      return { usedBytes: totalBytes - stats.bfree * stats.bsize, totalBytes };
    });
  let previous: (CpuTimes & { at: number }) | undefined;
  const cpuTimes = async () => parseCpuTimes(await read('/proc/stat').catch(() => ''));
  const cpuPercent = async (): Promise<number | null> => {
    let start = previous;
    // A previous sample older than five minutes would average over a period
    // nobody is looking at; take a short fresh interval instead.
    if (start === undefined || now() - start.at > 5 * 60_000) {
      const first = await cpuTimes();
      if (first === undefined) return null;
      start = { ...first, at: now() };
      await wait(250);
    }
    const current = await cpuTimes();
    if (current === undefined) return null;
    previous = { ...current, at: now() };
    const total = current.total - start.total;
    if (total <= 0) return null;
    return Math.min(
      100,
      Math.max(0, Math.round(((current.busy - start.busy) / total) * 1000) / 10),
    );
  };
  return async (): Promise<HostResources> => {
    const memory = parseMemory(await read('/proc/meminfo').catch(() => '')) ?? {
      usedBytes: totalmem() - freemem(),
      totalBytes: totalmem(),
    };
    const disk =
      options.dataRoot === undefined ? null : await measureDisk(options.dataRoot).catch(() => null);
    return {
      observedAt: new Date(now()).toISOString(),
      cpu: { percent: await cpuPercent(), cores: cpus().length },
      memory,
      disk,
    };
  };
}

/**
 * `GET /diagnostics/host`: administrators only, since it describes the
 * machine rather than anything a user owns. Behind the paired-device gate like
 * every route not listed in `route-scopes.ts`.
 */
export function registerHostResourcesRoute(
  app: FastifyInstance,
  deps: {
    isAdministrator: (userId: string | null) => Promise<boolean>;
    sample: () => Promise<HostResources>;
  },
): void {
  app.get('/diagnostics/host', async (request, reply) => {
    if (!(await deps.isAdministrator(request.localUserId)))
      return reply.code(403).send({ error: 'Administrator access required' });
    void reply.header('cache-control', 'no-store');
    return deps.sample();
  });
}
