import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { createSubprocessSecretJobRunner } from './secret-subprocess-job-runner.js';

const encoder = new TextEncoder();

function output(result: Awaited<ReturnType<ReturnType<typeof createSubprocessSecretJobRunner>>>) {
  return result.chunks.map(({ stream, chunk }) => ({
    stream,
    text: Buffer.from(chunk).toString('utf8'),
  }));
}

describe('subprocess secret job runner', () => {
  it('injects secrets through env without inheriting the worker environment', async () => {
    const run = createSubprocessSecretJobRunner({
      executablePath: process.execPath,
      arguments: [
        '-e',
        "process.stdout.write(process.env.API_TOKEN); process.stderr.write(process.env.HOME ?? 'absent')",
      ],
      baseEnv: {},
    });

    const result = await run(new Map([['API_TOKEN', encoder.encode('opened-secret')]]));

    expect(result.exitCode).toBe(0);
    const chunks = output(result);
    expect(
      chunks
        .filter(({ stream }) => stream === 'stdout')
        .map(({ text }) => text)
        .join(''),
    ).toBe('opened-secret');
    expect(
      chunks
        .filter(({ stream }) => stream === 'stderr')
        .map(({ text }) => text)
        .join(''),
    ).toBe('absent');
  });

  it('returns a non-zero child exit code', async () => {
    const run = createSubprocessSecretJobRunner({
      executablePath: process.execPath,
      arguments: ['-e', 'process.exit(17)'],
    });

    await expect(run(new Map())).resolves.toMatchObject({ exitCode: 17 });
  });

  it('rejects a missing executable', async () => {
    const run = createSubprocessSecretJobRunner({
      executablePath: '/definitely-not-a-verity-executable',
    });

    await expect(run(new Map())).rejects.toThrow(/ENOENT/);
  });

  it('kills the child and rejects when combined output exceeds the cap', async () => {
    const run = createSubprocessSecretJobRunner({
      executablePath: process.execPath,
      arguments: ['-e', "process.stdout.write('12345'); process.stderr.write('67890')"],
      maxOutputBytes: 9,
    });

    await expect(run(new Map())).rejects.toThrow(/exceeded the maximum size/);
  });

  it('rejects env values containing NUL before spawning', async () => {
    const run = createSubprocessSecretJobRunner({ executablePath: process.execPath });

    await expect(run(new Map([['API_TOKEN', encoder.encode('bad\0secret')]]))).rejects.toThrow(
      /not valid for env injection/,
    );
  });

  it('rejects invalid UTF-8 secret bytes before spawning', async () => {
    const run = createSubprocessSecretJobRunner({ executablePath: process.execPath });

    await expect(run(new Map([['API_TOKEN', Uint8Array.from([0xc3, 0x28])]]))).rejects.toThrow(
      /not valid UTF-8/,
    );
  });

  it('kills and rejects a child that exceeds the runtime cap', async () => {
    const run = createSubprocessSecretJobRunner({
      executablePath: process.execPath,
      arguments: ['-e', 'setInterval(() => undefined, 1_000)'],
      maxRuntimeMs: 25,
    });

    await expect(run(new Map())).rejects.toThrow(/exceeded the maximum runtime/);
  });

  it('kills background descendants after a successful direct child exit', async () => {
    const run = createSubprocessSecretJobRunner({
      executablePath: process.execPath,
      arguments: [
        '-e',
        [
          "const { spawn } = require('node:child_process')",
          "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' })",
          'descendant.unref()',
          'process.stdout.write(String(descendant.pid))',
        ].join(';'),
      ],
    });

    const result = await run(new Map([['API_TOKEN', encoder.encode('opened-secret')]]));
    expect(result.exitCode).toBe(0);
    const descendantPid = Number(
      output(result)
        .map(({ text }) => text)
        .join(''),
    );
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    const deadline = Date.now() + 1_000;
    let descendantState: string | undefined;
    do {
      try {
        descendantState = readFileSync(`/proc/${descendantPid}/stat`, 'utf8').split(' ')[2];
      } catch {
        descendantState = undefined; // A fully reaped process has no /proc entry.
      }
      if (descendantState === undefined || descendantState === 'Z') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    expect(descendantState === undefined || descendantState === 'Z').toBe(true);
  });

  it('rejects invalid secret and base-environment variable names', async () => {
    const run = createSubprocessSecretJobRunner({ executablePath: process.execPath });
    await expect(run(new Map([['INVALID-NAME', encoder.encode('secret')]]))).rejects.toThrow(
      /valid environment variable name/,
    );

    const runWithInvalidBase = createSubprocessSecretJobRunner({
      executablePath: process.execPath,
      baseEnv: { 'INVALID-NAME': 'value' },
    });
    await expect(runWithInvalidBase(new Map())).rejects.toThrow(/base environment/);
  });

  it('injects a __proto__ target as an own env key', async () => {
    const run = createSubprocessSecretJobRunner({
      executablePath: process.execPath,
      arguments: ['-e', "process.stdout.write(process.env.__proto__ ?? 'missing')"],
      baseEnv: {},
    });

    const result = await run(new Map([['__proto__', encoder.encode('opened-secret')]]));
    expect(
      output(result)
        .map(({ text }) => text)
        .join(''),
    ).toBe('opened-secret');
  });

  it('validates the executable path and resource caps', () => {
    expect(() => createSubprocessSecretJobRunner({ executablePath: 'relative' })).toThrow(
      /must be absolute/,
    );
    expect(() =>
      createSubprocessSecretJobRunner({ executablePath: process.execPath, maxOutputBytes: 0 }),
    ).toThrow(/positive integer/);
    expect(() =>
      createSubprocessSecretJobRunner({ executablePath: process.execPath, maxRuntimeMs: 0 }),
    ).toThrow(/positive integer/);
  });
});
