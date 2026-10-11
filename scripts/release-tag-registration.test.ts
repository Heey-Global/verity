import { describe, expect, it } from 'vitest';
import { registerReleaseTags } from './release-tag-registration.mjs';

const head = 'a'.repeat(40);
const release = 'b'.repeat(40);
const wrong = 'c'.repeat(40);
function fixture() {
  const tags = new Map<string, string>([
    ['mobile-v1.2.0', release],
    ['website-v2.0.0', release],
  ]);
  const writes: string[][] = [];
  let author = 'github-actions[bot]';
  let duplicate = false;
  let race: string | undefined;
  let mismatch = false;
  let ancestor = true;
  const run = (command: string, args: string[]): string => {
    if (command === 'gh') {
      if (args.includes('POST')) {
        writes.push(args);
        tags.set('v3.0.0', race ?? release);
        if (race) throw new Error('Already exists');
        return '{}';
      }
      const pr = {
        merged_at: '2026-10-09',
        merge_commit_sha: release,
        user: { login: author },
        head: { ref: 'release-please--branches--main--components--server' },
      };
      return [pr, ...(duplicate ? [pr] : [])].map((row) => JSON.stringify(row)).join('\n');
    }
    if (args[0] === 'ls-tree') return args[4]!;
    if (args[0] === 'show') {
      const ref = args[1]!;
      if (ref.includes('backend'))
        return JSON.stringify({ '.': mismatch && ref.startsWith(release) ? '2.0.0' : '3.0.0' });
      if (ref.includes('mobile')) return JSON.stringify({ 'apps/mobile': '1.2.0' });
      return JSON.stringify({ 'docs/website': '2.0.0' });
    }
    if (args[0] === 'merge-base') {
      if (!ancestor) throw new Error('Not ancestor');
      return '';
    }
    if (args[0] === 'ls-remote') {
      const tag = args[3]!.replace('refs/tags/', '');
      return tags.has(tag) ? `${tags.get(tag)}\trefs/tags/${tag}` : '';
    }
    throw new Error(`Unexpected ${command} ${args.join(' ')}`);
  };
  return {
    tags,
    writes,
    run,
    setAuthor: (value: string) => {
      author = value;
    },
    duplicate: () => {
      duplicate = true;
    },
    race: (value: string) => {
      race = value;
    },
    mismatch: () => {
      mismatch = true;
    },
    nonAncestor: () => {
      ancestor = false;
    },
  };
}
const invoke = (f: ReturnType<typeof fixture>, mode: 'register' | 'check' = 'register') =>
  registerReleaseTags(mode, head, { repository: 'example/repo', run: f.run });

describe('release tag registration', () => {
  it('reserves the exact merged source before publication, without pending labels', () => {
    const f = fixture();
    expect(invoke(f)[0]).toEqual({ tag: 'v3.0.0', sha: release });
    expect(f.writes[0]).toContain(`sha=${release}`);
    expect(invoke(f, 'check')).toHaveLength(3);
    expect(f.writes).toHaveLength(1);
  });
  it('blocks workflow changes while a current release tag is missing', () => {
    const f = fixture();
    expect(() => invoke(f, 'check')).toThrow('not registered');
    expect(f.writes).toHaveLength(0);
  });
  it('never accepts an existing tag pointing at another release commit', () => {
    const f = fixture();
    f.tags.set('v3.0.0', wrong);
    expect(() => invoke(f)).toThrow('differs');
    expect(f.writes).toHaveLength(0);
  });
  it('accepts only an identical tag when another registrar wins the race', () => {
    const f = fixture();
    f.race(release);
    expect(invoke(f)).toHaveLength(3);
    const conflict = fixture();
    conflict.race(wrong);
    expect(() => invoke(conflict)).toThrow('Already exists');
  });
  it('rejects unexpected authors and ambiguous release PRs', () => {
    const f = fixture();
    f.setAuthor('someone');
    expect(() => invoke(f)).toThrow('Unexpected author');
    const duplicate = fixture();
    duplicate.duplicate();
    expect(() => invoke(duplicate)).toThrow('Ambiguous');
  });
  it('requires a matching merged release version before creating a tag', () => {
    const f = fixture();
    f.mismatch();
    expect(() => invoke(f)).toThrow('Missing trusted');
    expect(f.writes).toHaveLength(0);
  });
  it('rejects tags outside the checked base history', () => {
    const f = fixture();
    f.tags.set('v3.0.0', release);
    f.nonAncestor();
    expect(() => invoke(f, 'check')).toThrow('Not ancestor');
  });
  it('ignores historical PRs predating manifests but propagates lookup failures', () => {
    const f = fixture();
    const run = (command: string, args: string[]) => {
      if (command === 'gh' && !args.includes('POST')) {
        return (
          f.run(command, args) +
          '\n' +
          JSON.stringify({
            merged_at: '2020-01-01',
            merge_commit_sha: wrong,
            user: { login: 'github-actions[bot]' },
            head: { ref: 'release-please--branches--main--components--server' },
          })
        );
      }
      if (args[0] === 'ls-tree' && args[2] === wrong) return '';
      return f.run(command, args);
    };
    expect(registerReleaseTags('register', head, { repository: 'example/repo', run })).toHaveLength(
      3,
    );
    expect(() =>
      registerReleaseTags('check', head, {
        repository: 'example/repo',
        run: (command, args) => {
          if (args[0] === 'ls-tree') throw new Error('Missing object');
          return run(command, args);
        },
      }),
    ).toThrow('Missing object');
  });
  it('validates historical backend tags with the legacy manifest key', () => {
    const f = fixture();
    const run = (command: string, args: string[]) => {
      if (args[0] === 'show' && args[1] === `${release}:.release-please-manifest.backend.json`)
        return JSON.stringify({ '.release/backend': '3.0.0' });
      return f.run(command, args);
    };
    expect(registerReleaseTags('register', head, { repository: 'example/repo', run })).toHaveLength(
      3,
    );
  });
});

describe('remote release tag verification', () => {
  it('peels annotated tags to the approved commit', () => {
    const f = fixture();
    f.tags.set('v3.0.0', release);
    const run = (command: string, args: string[]) => {
      const value = f.run(command, args);
      if (args[0] === 'ls-remote' && args[3] === 'refs/tags/v3.0.0')
        return `${wrong}\trefs/tags/v3.0.0\n${release}\trefs/tags/v3.0.0^{}`;
      return value;
    };
    expect(registerReleaseTags('check', head, { repository: 'example/repo', run })[0]?.sha).toBe(
      release,
    );
    expect(f.writes).toHaveLength(0);
  });
  it('does not turn a remote lookup failure into tag creation', () => {
    const f = fixture();
    expect(() =>
      registerReleaseTags('register', head, {
        repository: 'example/repo',
        run: (command, args) => {
          if (args[0] === 'ls-remote') throw new Error('Remote unavailable');
          return f.run(command, args);
        },
      }),
    ).toThrow('Remote unavailable');
    expect(f.writes).toHaveLength(0);
  });
});
