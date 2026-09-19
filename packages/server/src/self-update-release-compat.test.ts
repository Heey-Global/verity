import { describe, expect, it, vi } from 'vitest';
import { SERVER_COMPAT } from './self-update/compat.js';
import { checkReleaseImages } from './self-update-release-compat.js';

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

describe('release image compatibility gate', () => {
  it('rejects the published predecessor when it cannot read the candidate schema', () => {
    const docker = vi
      .fn<(args: string[]) => string>()
      .mockReturnValueOnce(JSON.stringify(previous))
      .mockReturnValueOnce(JSON.stringify(candidate));
    expect(() => checkReleaseImages('previous', 'candidate', docker)).toThrow(
      'Release is not reachable through self-update',
    );
    expect(docker.mock.calls.map(([args]) => args[7])).toEqual(['previous', 'candidate']);
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
      expect(args.at(-1)).toContain('/app/packages/server/dist/self-update/compat.js');
    }
  });

  it('accepts both hops only when the bridge promises the target schema', () => {
    const bridge = {
      ...previous,
      serverVersion: '0.15.2',
      schema: { ...previous.schema, max: candidate.schema.current },
    };
    for (const [from, to] of [
      [previous, bridge],
      [bridge, candidate],
    ]) {
      const docker = vi
        .fn<(args: string[]) => string>()
        .mockReturnValueOnce(JSON.stringify(from))
        .mockReturnValueOnce(JSON.stringify(to));
      expect(() => checkReleaseImages('previous', 'candidate', docker)).not.toThrow();
    }
  });

  it('still refuses protocol breaks with a forward schema promise', () => {
    const docker = vi
      .fn<(args: string[]) => string>()
      .mockReturnValueOnce(JSON.stringify(candidate))
      .mockReturnValueOnce(
        JSON.stringify({
          ...candidate,
          runner: { min: candidate.runner.current + 1, current: candidate.runner.current + 1 },
        }),
      );
    expect(() => checkReleaseImages('previous', 'candidate', docker)).toThrow(
      'runner protocol mismatch',
    );
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
