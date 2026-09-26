import { describe, expect, it } from 'vitest';
// @ts-expect-error -- executable JavaScript helper
import { promoteReleaseIndex, publishReleaseIndex } from './publish-release-index.mjs';

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

// A registry that answers `inspect` from its tag table and records `create`
// the way a single-source copy behaves: the tag names the source's digest.
function registry(tags: Record<string, string>, copy = (source: string) => source) {
  const writes: string[][] = [];
  const docker = (args: string[]) => {
    const reference = args.at(-1)!;
    if (args[0] === 'create') {
      writes.push(args);
      const tag = args[args.indexOf('--tag') + 1]!.split(':').at(-1)!;
      const source = args.at(-1)!;
      tags[tag] = source.includes('@') ? copy(source.split('@')[1]!) : `sha256:${'e'.repeat(64)}`;
      return '';
    }
    if (args.includes('--raw')) return index();
    if (reference === input.sources[0]) return sourceDigest;
    const found = tags[reference.split(':').at(-1)!];
    if (!found) throw absent();
    return found;
  };
  return { tags, writes, docker };
}

describe('staged release index publication', () => {
  const staged = { ...input, stageTag: 'candidate-v1.2.3' };

  it('stages the index under the stage tag and never writes the version tag', () => {
    const fake = registry({});
    const result = publishReleaseIndex(staged, fake.docker);
    expect(result.reused).toBe(false);
    expect(fake.tags['candidate-v1.2.3']).toBe(result.digest);
    // The version tag is what the release gate withholds; staging it would
    // publish the image before the self-update smoke passed.
    expect(fake.tags['v1.2.3']).toBeUndefined();
  });

  it('bundles an already released index instead of staging a twin', () => {
    const fake = registry({ 'v1.2.3': digest });
    expect(publishReleaseIndex(staged, fake.docker)).toEqual({ digest, reused: true });
    expect(fake.writes).toEqual([]);
  });

  it('reuses an index staged by an earlier attempt', () => {
    const fake = registry({ 'candidate-v1.2.3': digest });
    expect(publishReleaseIndex(staged, fake.docker)).toEqual({ digest, reused: true });
    expect(fake.writes).toEqual([]);
  });

  it.each(['v1.2.3', '-flag', 'with space', ''])('rejects stage tag %j', (stageTag) => {
    expect(() => publishReleaseIndex({ ...input, stageTag }, registry({}).docker)).toThrow(
      'Invalid stage tag',
    );
  });
});

describe('staged release index promotion', () => {
  const promotion = { ...input, digest };

  it('points the version tag at the staged digest', () => {
    const fake = registry({});
    expect(promoteReleaseIndex(promotion, fake.docker)).toEqual({ digest, reused: false });
    expect(fake.writes).toEqual([
      ['create', '--tag', `${input.image}:v1.2.3`, `${input.image}@${digest}`],
    ]);
    expect(fake.tags['v1.2.3']).toBe(digest);
  });

  it('leaves a version tag that already names the staged digest alone', () => {
    const fake = registry({ 'v1.2.3': digest });
    expect(promoteReleaseIndex(promotion, fake.docker)).toEqual({ digest, reused: true });
    expect(fake.writes).toEqual([]);
  });

  it('refuses to move a version tag that names another index', () => {
    const fake = registry({ 'v1.2.3': sourceDigest });
    expect(() => promoteReleaseIndex(promotion, fake.docker)).toThrow('is not the staged');
    expect(fake.writes).toEqual([]);
  });

  it('fails when the copy does not keep the digest the Server bundled', () => {
    // The Server image was built against `digest`; a rewritten index would
    // leave the release tag naming something the Server never pinned.
    const fake = registry({}, () => sourceDigest);
    expect(() => promoteReleaseIndex(promotion, fake.docker)).toThrow(
      `is ${sourceDigest}, not ${digest}`,
    );
  });
});
