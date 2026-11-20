import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { measureLintHeap } from './lint-heap-probe.mjs';
import { CI_HEAP_CAP_MIB, LOCAL_HEAP_CAP_MIB } from './lint-runner.mjs';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

it.each([false, true])('retains native traces and the worker outcome after OOM=%s', (oom) => {
  const directory = mkdtempSync(join(tmpdir(), 'lint-heap-'));
  temporary.push(directory);
  const trace = 'gc=ms total_size_before=123456 total_size_after=98765\n';
  const stderr = oom ? 'FATAL ERROR: Allocation failed - JavaScript heap out of memory\n' : '';
  vi.mocked(spawnSync).mockImplementation((_command, _args, options) => {
    const [, stdout, error] = options!.stdio as ['ignore', number, number];
    writeFileSync(stdout, trace);
    writeFileSync(error, stderr);
    return {
      pid: 1,
      output: [null, null, null],
      stdout: null,
      stderr: null,
      status: oom ? null : 0,
      signal: oom ? 'SIGABRT' : null,
    };
  });
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);

  expect(measureLintHeap(directory)).toBe(oom ? 1 : 0);
  expect(spawnSync).toHaveBeenCalledTimes(1);
  expect(readFileSync(join(directory, 'worker-gc.log'), 'utf8')).toBe(trace);
  expect(readFileSync(join(directory, 'worker-stderr.log'), 'utf8')).toBe(stderr);
  const metadata = JSON.parse(readFileSync(join(directory, 'worker.json'), 'utf8')) as {
    files: string[];
    heapMiB: number;
    ambientCache: boolean;
    signal: string | null;
  };
  expect(metadata.files).toEqual(['packages/server/src/server.ts']);
  expect(metadata.heapMiB).toBeGreaterThan(0);
  // The probe must measure under the runner's own budget for this environment.
  expect(metadata.heapMiB).toBeLessThanOrEqual(
    process.env.GITHUB_ACTIONS === 'true' ? CI_HEAP_CAP_MIB : LOCAL_HEAP_CAP_MIB,
  );
  expect(metadata.ambientCache).toBe(false);
  expect(metadata.signal).toBe(oom ? 'SIGABRT' : null);
  const args = vi.mocked(spawnSync).mock.calls[0]![1] as string[];
  expect(args).toContain(`--max-old-space-size=${metadata.heapMiB}`);
  expect(args).toContain('--trace-gc-nvp');
  expect(args).toContain('--no-ambient-cache');
  expect(args).not.toContain('--local-cache');
});

type Step = { uses?: string; run?: string; if?: string; with?: Record<string, unknown> };
type Job = { if?: string; steps: Step[]; concurrency?: { 'cancel-in-progress': boolean } };

it('isolates manual heap measurement from the full comparison with the canonical CI installation', () => {
  const workflow = parse(readFileSync('.github/workflows/lint-comparison.yml', 'utf8')) as {
    on: { workflow_dispatch: { inputs: Record<string, { default: boolean }> } };
    jobs: Record<string, Job>;
  };
  const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
    jobs: Record<string, Job>;
  };
  const probe = workflow.jobs['server-heap']!;
  expect(workflow.on.workflow_dispatch.inputs['server-heap-only']?.default).toBe(false);
  expect(probe.if).toBe("github.event_name == 'workflow_dispatch' && inputs['server-heap-only']");
  expect(workflow.jobs['compare']!.if).toBe("${{ !inputs['server-heap-only'] }}");
  expect(probe.concurrency?.['cancel-in-progress']).toBe(false);
  const install = (job: Job) => job.steps.find((step) => step.run?.startsWith('npm ci'))?.run;
  expect(install(probe)).toBeDefined();
  expect(install(probe)).toBe(install(ci.jobs['lint']!));
  const upload = probe.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  expect(upload?.if).toBe('always()');
  expect(upload?.with?.['retention-days']).toBeLessThanOrEqual(7);
});
