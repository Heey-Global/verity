import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';

export interface ProcessResources {
  rssBytes: number;
  heapUsedBytes: number;
  heapLimitBytes: number;
  externalBytes: number;
  cpuUserSeconds: number;
  cpuSystemSeconds: number;
  eventLoopDelayMs: { p50: number; p99: number; max: number } | null;
}

/**
 * Process-level resources. The event-loop delay histogram samples every 20 ms
 * and only while measurement is on; it is the cheapest signal that the server
 * is too busy to answer promptly, independent of any single request.
 */
export class ProcessSampler {
  private loop: ReturnType<typeof monitorEventLoopDelay> | null = null;

  setActive(active: boolean): void {
    if (active && this.loop === null) {
      this.loop = monitorEventLoopDelay({ resolution: 20 });
      this.loop.enable();
    } else if (!active && this.loop !== null) {
      this.loop.disable();
      this.loop = null;
    }
  }

  sample(): ProcessResources {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    const loop = this.loop;
    const ms = (ns: number) => Math.round((ns / 1e6) * 10) / 10;
    return {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapLimitBytes: getHeapStatistics().heap_size_limit,
      externalBytes: memory.external,
      cpuUserSeconds: Math.round(cpu.user / 1e4) / 100,
      cpuSystemSeconds: Math.round(cpu.system / 1e4) / 100,
      eventLoopDelayMs:
        loop === null || loop.count === 0
          ? null
          : { p50: ms(loop.percentile(50)), p99: ms(loop.percentile(99)), max: ms(loop.max) },
    };
  }
}
