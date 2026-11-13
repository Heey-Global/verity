import { afterEach, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CI_GROUP_BYTES,
  CI_GROUP_FILES,
  CI_GROUP_MIN_HEAP_MIB,
  CI_HEAP_CAP_MIB,
  LOCAL_GROUP_BYTES,
  LOCAL_GROUP_FILES,
  LOCAL_HEAP_CAP_MIB,
  heapLimitMiB,
  lintGroupLimits,
  lintWorkerArguments,
  runLint,
  workerHeapLimit,
} from './lint-runner.mjs';

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
const outOfMemory = {
  status: null,
  signal: 'SIGABRT' as const,
  stderr: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
};
function options() {
  return {
    heapMiB: 96,
    // The suite itself runs on CI runners; pin the sandbox groups the other
    // assertions are written for, so they do not pass locally and fail in CI.
    groupFiles: LOCAL_GROUP_FILES,
    groupBytes: LOCAL_GROUP_BYTES,
    output: vi.fn<(text: string) => void>(),
    error: vi.fn<(text: string) => void>(),
  };
}

it('retries every file after an OOM without increasing the heap budget', () => {
  const files = ['first.ts', 'second.ts', 'third.ts', 'last.ts'];
  const checked: string[] = [];
  const execute = vi.fn((batch: string[], heap: number) => {
    expect(heap).toBe(io.heapMiB);
    if (batch.length > 1) return outOfMemory;
    checked.push(...batch);
    return { status: 0, stdout: `${batch[0]} checked\n` };
  });
  const io = options();
  expect(runLint(files, { ...io, execute })).toBe(0);
  expect(checked).toEqual(files);
  expect(execute.mock.calls.every(([, heap]) => heap === io.heapMiB)).toBe(true);
  expect(io.output.mock.calls.map(([text]) => text).join('')).not.toContain('FATAL ERROR');
  expect(io.error.mock.calls.map(([text]) => text).join('')).toContain('smaller groups');
});

it('splits a group killed by an external memory guard', () => {
  const files = ['first.ts', 'second.ts'];
  const execute = vi.fn((batch: string[]) =>
    batch.length > 1 ? { status: null, signal: 'SIGKILL' as const } : { status: 0 },
  );
  expect(runLint(files, { ...options(), execute })).toBe(0);
  expect(execute.mock.calls.slice(1).flatMap(([batch]) => batch)).toEqual(files);
});

it('fails explicitly when even one file cannot fit, without accepting a partial result', () => {
  const execute = vi.fn(() => ({ ...outOfMemory, stdout: 'partial output' }));
  const io = options();
  expect(runLint(['large.ts'], { ...io, execute })).toBe(1);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(io.output).not.toHaveBeenCalled();
  expect(io.error.mock.calls.map(([text]) => text).join('')).toContain('large.ts');
  expect(io.error.mock.calls.map(([text]) => text).join('')).toContain('No successful lint result');
});

it.each([
  { status: 1, stdout: 'lint finding' },
  { status: null, signal: 'SIGABRT' as const, stderr: 'native assertion failure' },
  { status: null, signal: 'SIGTERM' as const },
  { status: null, error: new Error('worker could not start') },
])('does not retry ordinary lint errors, unrelated crashes or startup failures: %j', (result) => {
  const execute = vi.fn(() => result);
  expect(runLint(['first.ts', 'second.ts'], { ...options(), execute })).not.toBe(0);
  expect(execute).toHaveBeenCalledTimes(1);
});

it('bounds initial groups and preserves complete coverage for a large scoped invocation', () => {
  const files = Array.from({ length: 35 }, (_, index) => `${index}.ts`);
  const execute = vi.fn((batch: string[]) => {
    expect(batch.length).toBeGreaterThan(0);
    return { status: 0 };
  });
  expect(runLint(files, { ...options(), execute })).toBe(0);
  expect(execute.mock.calls.every(([batch]) => batch.length <= 16)).toBe(true);
  expect(execute.mock.calls.flatMap(([batch]) => batch)).toEqual(files);
});

it('groups CI runs in larger workers and keeps sandboxes at the small groups', () => {
  // Small groups rebuild the server's type graph about 200 times in CI; large
  // groups in a sandbox would hold that graph in memory other sessions share.
  expect(lintGroupLimits(true)).toEqual({ files: CI_GROUP_FILES, bytes: CI_GROUP_BYTES });
  expect(lintGroupLimits(false)).toEqual({ files: LOCAL_GROUP_FILES, bytes: LOCAL_GROUP_BYTES });
  expect(CI_GROUP_FILES).toBeGreaterThan(LOCAL_GROUP_FILES);
  // A CI runner with less memory keeps small groups instead of failing large ones first.
  expect(lintGroupLimits(true, CI_GROUP_MIN_HEAP_MIB - 1)).toEqual({
    files: LOCAL_GROUP_FILES,
    bytes: LOCAL_GROUP_BYTES,
  });
  expect(lintGroupLimits(true, CI_GROUP_MIN_HEAP_MIB).files).toBe(CI_GROUP_FILES);
  const files = Array.from({ length: CI_GROUP_FILES + 5 }, (_, index) => `${index}.ts`);
  const previous = { ci: process.env.CI, actions: process.env.GITHUB_ACTIONS };
  const run = () => {
    const execute = vi.fn<(batch: string[]) => { status: number }>(() => ({ status: 0 }));
    // Leave the group limits to the environment for this run.
    const io: Partial<ReturnType<typeof options>> = { ...options(), heapMiB: CI_HEAP_CAP_MIB };
    delete io.groupFiles;
    delete io.groupBytes;
    expect(runLint(files, { ...io, execute })).toBe(0);
    expect(execute.mock.calls.flatMap(([batch]) => batch)).toEqual(files);
    return Math.max(...execute.mock.calls.map(([batch]) => batch.length));
  };
  try {
    process.env.GITHUB_ACTIONS = 'true';
    expect(run()).toBe(CI_GROUP_FILES);
    // CI=1 alone, as tools set it in sandboxes, keeps the small groups.
    delete process.env.GITHUB_ACTIONS;
    process.env.CI = '1';
    expect(run()).toBe(LOCAL_GROUP_FILES);
  } finally {
    if (previous.ci === undefined) delete process.env.CI;
    else process.env.CI = previous.ci;
    if (previous.actions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = previous.actions;
  }
});

it('sizes the type program to the whole worker group', () => {
  // A second program for the same project in one worker cannot be collected in
  // time; the worker must size its program to the whole group it was given.
  const files = Array.from({ length: 40 }, (_, index) => `${index}.ts`);
  const args = lintWorkerArguments(files, 512, false, true);
  expect(args).toContain(`--type-batch=${files.length}`);
  expect(args.slice(args.indexOf('--') + 1)).toEqual(files);
});

it('separates large sources before starting workers and still checks oversized files', () => {
  mkdirSync('.cache', { recursive: true });
  const root = mkdtempSync(resolve('.cache/lint-runner-'));
  temporary.push(root);
  const files = [70, 70, 200, 10].map((kib, index) => {
    const file = join(root, `${index}.ts`);
    writeFileSync(file, ' '.repeat(kib * 1024));
    return file;
  });
  const execute = vi.fn((batch: string[]) => {
    expect(batch).toHaveLength(1);
    return { status: 0 };
  });
  expect(runLint(files, { ...options(), execute })).toBe(0);
  expect(execute.mock.calls.flatMap(([batch]) => batch)).toEqual(files);
});

it('keeps heap limits below the ceiling and available room', () => {
  const MiB = 1024 * 1024;
  const ceiling = 1024 * MiB;
  const current = 512 * MiB;
  const heap = heapLimitMiB(ceiling, current) * MiB;
  expect(heap).toBeGreaterThan(0);
  expect(heap).toBeLessThan(ceiling / 2);
  expect(heap).toBeLessThan((ceiling - current) / 2);
  expect(() => heapLimitMiB(ceiling, ceiling - 32 * MiB)).toThrow('Insufficient available memory');
  for (const missing of [0, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
    expect(heapLimitMiB(missing)).toBeGreaterThan(0);
    expect(heapLimitMiB(missing)).toBeLessThanOrEqual(512);
  }
});

it('gives CI runners without a cgroup limit the CI budget instead of the sandbox fallback', () => {
  // Hosted runners expose no container limit. Treating that as "unknown" kept CI at
  // the sandbox budget, where the server's type graph fails by a few MiB; the run
  // only goes red once the graph grows, with nothing pointing at this fallback.
  const GiB = 1024 ** 3;
  expect(
    workerHeapLimit({ ci: true, limits: [], current: 0, total: 16 * GiB, free: 14 * GiB }),
  ).toBe(CI_HEAP_CAP_MIB);
  // Memory the runner already uses is not offered to the worker.
  expect(
    workerHeapLimit({ ci: true, limits: [], current: 0, total: 16 * GiB, free: 2 * GiB }),
  ).toBeLessThan(CI_HEAP_CAP_MIB);
  expect(CI_HEAP_CAP_MIB).toBeGreaterThan(LOCAL_HEAP_CAP_MIB);
  // A small runner stays within a quarter of its memory and keeps room in reserve.
  const small = workerHeapLimit({
    ci: true,
    limits: [],
    current: 0,
    total: 4 * GiB,
    free: 4 * GiB,
  });
  expect(small).toBeGreaterThan(LOCAL_HEAP_CAP_MIB);
  expect(small * 1024 ** 2).toBeLessThanOrEqual((4 * GiB) / 4);
});

it('does not treat a CI=1 sandbox as a CI runner', () => {
  // Tools export CI=1 to suppress prompts in sandboxes too. Keying the CI budget on
  // it would size sandbox workers from memory other sessions share.
  const previous = { ci: process.env.CI, actions: process.env.GITHUB_ACTIONS };
  process.env.CI = '1';
  delete process.env.GITHUB_ACTIONS;
  try {
    expect(workerHeapLimit({ limits: [], current: 0, total: 64 * 1024 ** 3 })).toBe(
      LOCAL_HEAP_CAP_MIB,
    );
  } finally {
    if (previous.ci === undefined) delete process.env.CI;
    else process.env.CI = previous.ci;
    if (previous.actions !== undefined) process.env.GITHUB_ACTIONS = previous.actions;
  }
});

it('keeps sandboxes at the local budget even when their machine is large', () => {
  // Sandbox machine memory is shared with other sessions; only a detected container
  // limit may size a worker there, and the local cap still bounds it.
  const GiB = 1024 ** 3;
  expect(workerHeapLimit({ ci: false, limits: [], current: 0, total: 64 * GiB })).toBe(
    LOCAL_HEAP_CAP_MIB,
  );
  expect(workerHeapLimit({ ci: false, limits: [32 * GiB], current: 0 })).toBe(LOCAL_HEAP_CAP_MIB);
  // A detected container limit keeps bounding CI as well.
  expect(workerHeapLimit({ ci: true, limits: [2 * GiB], current: GiB })).toBeLessThanOrEqual(512);
});

it('reports a real lint finding through the bounded worker CLI', () => {
  mkdirSync('.cache', { recursive: true });
  const root = mkdtempSync(resolve('.cache/lint-runner-'));
  temporary.push(root);
  const file = join(root, 'invalid.js');
  writeFileSync(file, 'missingFunction();\n');
  const result = spawnSync(process.execPath, ['scripts/lint-runner.mjs', '--', file], {
    encoding: 'utf8',
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('no-undef');
  expect(result.stderr).not.toContain('smaller groups');
});

it('reuses clean local CLI results while CI and --no-cache always check afresh', () => {
  mkdirSync('.cache', { recursive: true });
  const root = mkdtempSync(resolve('.cache/lint-runner-'));
  temporary.push(root);
  const file = join(root, 'clean.js');
  writeFileSync(file, 'export const clean = 1;\n');
  const run = (args: string[], ci = '') => {
    const result = spawnSync(process.execPath, ['scripts/lint-runner.mjs', ...args, '--', file], {
      env: { ...process.env, CI: ci },
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    return result.stdout;
  };
  expect(run([])).not.toContain('Reused clean lint results');
  expect(run([])).toContain('Reused clean lint results for 1 files');
  expect(run(['--no-cache'])).not.toContain('Reused clean lint results');
  expect(run([], 'true')).not.toContain('Reused clean lint results');
});

it('passes worker arguments literally and disables core dumps', () => {
  mkdirSync('.cache', { recursive: true });
  const root = mkdtempSync(resolve('.cache/lint-runner-'));
  temporary.push(root);
  const marker = join(root, 'injected');
  const argument = `space ' " ; touch ${marker}; $(touch ${marker})`;
  const result = spawnSync(
    'bash',
    [
      'scripts/lint-worker.sh',
      'bash',
      '-c',
      'ulimit -c; printf "%s" "$1"',
      'argument-check',
      argument,
    ],
    { encoding: 'utf8' },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(`0\n${argument}`);
  expect(existsSync(marker)).toBe(false);
});

it('retries a single OOM without ambient metadata at the same heap and requires a clean result', () => {
  const io = options();
  const execute = vi.fn((files: string[], heap: number, ambient: boolean) => {
    expect(files).toEqual(['large.ts']);
    expect(heap).toBe(io.heapMiB);
    return ambient ? outOfMemory : { status: 0, stdout: 'fully checked' };
  });
  expect(runLint(['large.ts'], { ...io, execute })).toBe(0);
  expect(execute.mock.calls.map(([, , ambient]) => ambient)).toEqual([true, false]);
  expect(io.output.mock.calls.map(([text]) => text).join('')).toBe('fully checked');
});

it('preserves findings from the fresh worker and never retries an already disabled cache', () => {
  const execute = vi.fn((_files: string[], _heap: number, ambient: boolean) =>
    ambient ? outOfMemory : { status: 1, stdout: 'real lint finding' },
  );
  const io = options();
  expect(runLint(['large.ts'], { ...io, execute })).toBe(1);
  expect(io.output.mock.calls.map(([text]) => text).join('')).toContain('real lint finding');
  const disabled = vi.fn(() => outOfMemory);
  expect(runLint(['large.ts'], { ...options(), ambientCache: false, execute: disabled })).toBe(1);
  expect(disabled).toHaveBeenCalledTimes(1);
});
