import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { runInThisContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { SERVER_COMPAT, isCompatible, parseServerCompat } from './self-update/compat.js';
import { createReleaseChannelResolver } from './self-update/release-channel.js';
import { checkReleaseImages, releaseDiscoveryProbe } from './self-update-release-compat.js';

const previous = {
  ...SERVER_COMPAT,
  serverVersion: '0.15.1',
  schema: {
    min: SERVER_COMPAT.schema.min,
    current: '0097_remove_cross_project_workflows',
    max: '0097_remove_cross_project_workflows',
  },
};
const candidate = { ...SERVER_COMPAT, serverVersion: '0.16.0' };

async function executeProbe(resolver: typeof createReleaseChannelResolver, target = candidate) {
  const source = releaseDiscoveryProbe(target).replace(/^import .*;$/gm, '');
  let output = '';
  const run = runInThisContext(
    `(async (SERVER_COMPAT, createReleaseChannelResolver, process) => { ${source} })`,
  ) as (
    current: typeof previous,
    resolver: typeof createReleaseChannelResolver,
    process: { stdout: { write: (value: string) => void } },
  ) => Promise<void>;
  await run(previous, resolver, {
    stdout: {
      write: (value: string) => {
        output += value;
      },
    },
  });
  return JSON.parse(output) as { state: string; reasons?: string[] };
}

describe('release image compatibility gate', () => {
  it('runs discovery inside the predecessor rather than trusting the local comparator', () => {
    const docker = vi
      .fn<(args: string[]) => string>()
      .mockReturnValueOnce(JSON.stringify(candidate))
      .mockReturnValueOnce(
        JSON.stringify({ state: 'incompatible', reasons: ['legacy schema rejection'] }),
      );
    expect(() => checkReleaseImages('previous', 'candidate', docker)).toThrow(
      'legacy schema rejection',
    );
    expect(docker.mock.calls.map(([args]) => args[7])).toEqual(['candidate', 'previous']);
    expect(docker.mock.calls[1]![0].at(-1)).toContain('await resolver.resolve()');
    for (const [args] of docker.mock.calls) {
      expect(args.slice(0, 7)).toEqual([
        'run',
        '--rm',
        '--network',
        'none',
        '--read-only',
        '--entrypoint',
        'node',
      ]);
    }
  });

  it('accepts only an available result, never a current or unreachable result', () => {
    for (const state of ['available', 'current', 'unreachable', 'unsupported']) {
      const docker = vi
        .fn<(args: string[]) => string>()
        .mockReturnValueOnce(JSON.stringify(candidate))
        .mockReturnValueOnce(JSON.stringify({ state }));
      const check = () => checkReleaseImages('previous', 'candidate', docker);
      if (state === 'available') expect(check).not.toThrow();
      else expect(check).toThrow('Release is not reachable');
    }
  });

  it('executes the real directional discovery implementation for a schema upgrade', async () => {
    expect((await executeProbe(createReleaseChannelResolver)).state).toBe('available');
  });

  it('still rejects the transition under the shipped legacy symmetric discovery policy', async () => {
    // Substituting the comparator recreates the old policy while retaining the actual parser and resolver.
    const source = readFileSync(
      new URL('./self-update/release-channel.ts', import.meta.url),
      'utf8',
    )
      .replace(/^import .*;$/gm, '')
      .replaceAll('isUpgradeCompatible(', 'isCompatible(');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText;
    const loadLegacy = runInThisContext(
      `((exports, isCompatible, parseServerCompat) => { ${compiled}; return exports.createReleaseChannelResolver; })`,
    ) as (
      exports: object,
      compare: typeof isCompatible,
      parse: typeof parseServerCompat,
    ) => typeof createReleaseChannelResolver;
    const legacy = loadLegacy({}, isCompatible, parseServerCompat);
    expect((await executeProbe(legacy)).state).toBe('incompatible');
  });

  it('rejects protocol breaks through the real resolver', async () => {
    const result = await executeProbe(createReleaseChannelResolver, {
      ...candidate,
      runner: { min: candidate.runner.current + 1, current: candidate.runner.current + 1 },
    });
    expect(result.state).toBe('incompatible');
    expect(result.reasons?.join(' ')).toContain('runner protocol mismatch');
  });

  it.each(['not json', '{}'])('fails closed on invalid image output %s', (output) => {
    expect(() => checkReleaseImages('previous', 'candidate', () => output)).toThrow();
  });

  it('propagates a failed image probe', () => {
    expect(() =>
      checkReleaseImages('previous', 'candidate', () => {
        throw new Error('image unavailable');
      }),
    ).toThrow('image unavailable');
  });
});
