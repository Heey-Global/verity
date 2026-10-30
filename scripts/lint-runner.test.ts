import { afterEach, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { heapLimitMiB, runLint } from './lint-runner.mjs';

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
  expect(execute).toHaveBeenCalledTimes(1);
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
