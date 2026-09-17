import { describe, expect, it } from 'vitest';
// @ts-expect-error -- executable JavaScript helper
import { publishReleaseIndex } from './publish-release-index.mjs';

const digest = `sha256:${'a'.repeat(64)}`;
const sourceDigest = `sha256:${'b'.repeat(64)}`;
const input = {
  image: 'ghcr.io/example/app',
  version: '1.2.3',
  sourceSha: 'c'.repeat(40),
  sources: ['ghcr.io/example/app:sha-source-amd64'],
};
function index(revision = input.sourceSha) {
  return JSON.stringify({
    manifests: [{ digest: sourceDigest }],
    annotations: {
      'org.opencontainers.image.revision': revision,
      'org.opencontainers.image.version': `v${input.version}`,
    },
  });
}
function absent() {
  return Object.assign(new Error('inspect failed'), { stderr: 'ERROR: manifest unknown' });
}

describe('immutable release index publication', () => {
  it('reuses a matching existing index without inspecting sources or writing', () => {
    const calls: string[][] = [];
    const result = publishReleaseIndex(input, (args: string[]) => {
      calls.push(args);
      return args.includes('--raw') ? index() : digest;
    });
    expect(result).toEqual({ digest, reused: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain(`${input.image}@${digest}`);
  });

  it('rejects a conflicting existing revision without mutation', () => {
    const calls: string[][] = [];
    expect(() =>
      publishReleaseIndex(input, (args: string[]) => {
        calls.push(args);
        return args.includes('--raw') ? index('d'.repeat(40)) : digest;
      }),
    ).toThrow('conflicting');
    expect(calls.every((args) => args[0] === 'inspect')).toBe(true);
  });

  it('resolves source tags to immutable digests before creating an annotated index', () => {
    const calls: string[][] = [];
    let created = false;
    const result = publishReleaseIndex(input, (args: string[]) => {
      calls.push(args);
      if (args[0] === 'create') {
        created = true;
        return '';
      }
      if (args.includes('--raw')) return index();
      if (args.at(-1) === input.sources[0]) return sourceDigest;
      if (!created) throw absent();
      return digest;
    });
    expect(result).toEqual({ digest, reused: false });
    const create = calls.find((args) => args[0] === 'create')!;
    expect(create).toContain(`${input.image}@${sourceDigest}`);
    expect(create).not.toContain(input.sources[0]);
    expect(create).toContain(`index:org.opencontainers.image.revision=${input.sourceSha}`);
    expect(create).toContain('index:org.opencontainers.image.version=v1.2.3');
  });

  it.each([
    'unauthorized',
    'connection timeout',
    'not found: unauthorized',
    '503 Service Unavailable',
  ])('fails closed for registry error %s', (stderr) => {
    expect(() =>
      publishReleaseIndex(input, () => {
        throw Object.assign(new Error('registry failure'), { stderr });
      }),
    ).toThrow('registry failure');
  });

  it('reuses an index that appears during source resolution', () => {
    let targetReads = 0;
    const result = publishReleaseIndex(input, (args: string[]) => {
      if (args[0] === 'create') throw new Error('must not overwrite');
      if (args.includes('--raw')) return index();
      if (args.at(-1) === input.sources[0]) return sourceDigest;
      if (targetReads++ === 0) throw absent();
      return digest;
    });
    expect(result).toEqual({ digest, reused: true });
  });

  it('verifies annotations after creating the index', () => {
    let created = false;
    expect(() =>
      publishReleaseIndex(input, (args: string[]) => {
        if (args[0] === 'create') {
          created = true;
          return '';
        }
        if (args.includes('--raw')) return index('d'.repeat(40));
        if (args.at(-1) === input.sources[0]) return sourceDigest;
        if (!created) throw absent();
        return digest;
      }),
    ).toThrow('conflicting');
  });

  it('rejects an existing index with the wrong release version', () => {
    expect(() =>
      publishReleaseIndex(input, (args: string[]) =>
        args.includes('--raw') ? index().replace('v1.2.3', 'v9.0.0') : digest,
      ),
    ).toThrow('conflicting');
  });

  it('rejects malformed registry digests', () => {
    expect(() => publishReleaseIndex(input, () => 'not-a-digest')).toThrow(
      'invalid manifest digest',
    );
  });
});
