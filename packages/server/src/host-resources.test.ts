import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  createHostResourcesSampler,
  parseCpuTimes,
  parseMemory,
  registerHostResourcesRoute,
} from './host-resources.js';

const GiB = 1024 ** 3;
const stat = (busy: number, idle: number) =>
  `cpu  ${busy} 0 0 ${idle} 0 0 0 0 0 0\ncpu0 1 0 0 1 0 0 0 0 0 0\n`;
const meminfo = [
  `MemTotal:       ${(8 * GiB) / 1024} kB`,
  `MemFree:        ${(1 * GiB) / 1024} kB`,
  `MemAvailable:   ${(6 * GiB) / 1024} kB`,
].join('\n');

describe('host resources', () => {
  // iowait is idle time; counting it as busy would report a machine waiting on a
  // full disk as fully loaded.
  it('reads busy and total CPU time with iowait as idle', () => {
    expect(parseCpuTimes('cpu  10 2 3 80 5 0 0 0 0 0\n')).toEqual({ busy: 15, total: 100 });
    expect(parseCpuTimes('nothing here')).toBeUndefined();
  });

  // MemFree would report the page cache as used and every busy host as full.
  it('counts available memory, not free memory, as unused', () => {
    expect(parseMemory(meminfo)).toEqual({ usedBytes: 2 * GiB, totalBytes: 8 * GiB });
    expect(parseMemory('MemTotal: 1 kB')).toBeUndefined();
  });

  it('measures CPU over the interval since the previous sample', async () => {
    const reads = [stat(10, 90), stat(10, 90), stat(40, 160)];
    let now = 0;
    const sample = createHostResourcesSampler({
      dataRoot: '/data',
      readProcFile: async (path) => (path === '/proc/meminfo' ? meminfo : reads.shift()!),
      measureDisk: async () => ({ usedBytes: 400 * GiB, totalBytes: 465 * GiB }),
      now: () => now,
      wait: async () => {},
    });
    // First call: no previous sample, so two identical readings → no interval yet.
    expect((await sample()).cpu.percent).toBeNull();
    now += 5000;
    // 30 busy of 100 total ticks since the previous sample.
    const second = await sample();
    expect(second.cpu.percent).toBe(30);
    expect(second.memory).toEqual({ usedBytes: 2 * GiB, totalBytes: 8 * GiB });
    expect(second.disk).toEqual({ usedBytes: 400 * GiB, totalBytes: 465 * GiB });
  });

  it('reports no disk without a data root and none it cannot measure', async () => {
    const base = { readProcFile: async () => '', wait: async () => {} };
    expect((await createHostResourcesSampler(base)()).disk).toBeNull();
    const failing = createHostResourcesSampler({
      ...base,
      dataRoot: '/missing',
      measureDisk: async () => {
        throw new Error('ENOENT');
      },
    });
    expect((await failing()).disk).toBeNull();
  });

  // The figures describe the machine, not anything a user owns.
  it('serves administrators only', async () => {
    const app = Fastify();
    app.decorateRequest('localUserId', null);
    app.addHook('onRequest', async (request) => {
      (request as { localUserId: string | null }).localUserId =
        (request.headers['x-user'] as string | undefined) ?? null;
    });
    registerHostResourcesRoute(app, {
      isAdministrator: async (userId) => userId === 'admin',
      sample: async () => ({
        observedAt: '2026-11-27T00:00:00.000Z',
        cpu: { percent: 1, cores: 2 },
        memory: { usedBytes: 1, totalBytes: 2 },
        disk: null,
      }),
    });
    const member = await app.inject({ url: '/diagnostics/host', headers: { 'x-user': 'member' } });
    expect(member.statusCode).toBe(403);
    const admin = await app.inject({ url: '/diagnostics/host', headers: { 'x-user': 'admin' } });
    expect(admin.statusCode).toBe(200);
    expect(admin.headers['cache-control']).toBe('no-store');
    expect(admin.json().cpu).toEqual({ percent: 1, cores: 2 });
    await app.close();
  });
});
