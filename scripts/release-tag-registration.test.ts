import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readFileSync: vi.fn((...args: Parameters<typeof readFileSync>) => {
    if (String(args[0]).endsWith('/.release-source-recoveries.json'))
      return JSON.stringify({ 'v3.0.0': { original: release, source: head } });
    throw new Error('Unexpected recovery file read');
  }),
}));
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
    if (args[0] === 'fetch') return '';
    if (command === 'gh' && args.includes('.object.sha')) return head;
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
      if (!ancestor) throw Object.assign(new Error('Not ancestor'), { status: 1 });
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
  it.each(['check', 'register'] as const)(
    'accepts an explicitly recorded recovery source in %s mode',
    (mode) => {
      const f = fixture();
      f.tags.set('v3.0.0', head);
      expect(invoke(f, mode)[0]).toEqual({ tag: 'v3.0.0', sha: head });
      expect(f.writes).toHaveLength(0);
    },
  );
  it('requires the recorded original source to match the trusted release merge', () => {
    const f = fixture();
    f.tags.set('v3.0.0', head);
    vi.mocked(readFileSync).mockReturnValueOnce(
      JSON.stringify({ 'v3.0.0': { original: wrong, source: head } }),
    );
    expect(() => invoke(f, 'check')).toThrow('differs');
  });
  it('rejects a recorded recovery outside the original release ancestry', () => {
    const f = fixture();
    f.tags.set('v3.0.0', head);
    let lookups = 0;
    expect(() =>
      registerReleaseTags('check', head, {
        repository: 'example/repo',
        run: (command, args) => {
          if (args[0] === 'merge-base' && args[2] === release && args[3] === head && ++lookups > 1)
            throw Object.assign(new Error('Not ancestor'), { status: 1 });
          return f.run(command, args);
        },
      }),
    ).toThrow('differs');
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

describe('later trusted merge identity for an already included version', () => {
  const current = 'd'.repeat(40);
  function supersededFixture() {
    const f = fixture();
    let mobileAuthor = 'github-actions[bot]';
    let duplicate = false;
    let brokenAncestry = false;
    const run = (command: string, args: string[]): string => {
      if (command === 'gh' && args.includes('.object.sha')) return current;
      if (command === 'gh' && !args.includes('POST')) {
        const pr = {
          merged_at: '2026-10-23',
          merge_commit_sha: wrong,
          user: { login: mobileAuthor },
          head: { ref: 'release-please--branches--main--components--mobile' },
        };
        return [
          f.run(command, args),
          JSON.stringify(pr),
          ...(duplicate ? [JSON.stringify(pr)] : []),
        ].join('\n');
      }
      if (args[0] === 'fetch') return '';
      if (args[0] === 'merge-base' && args[2] === wrong && args[3] === head)
        throw Object.assign(new Error('Not ancestor'), { status: 1 });
      if (args[0] === 'merge-base' && brokenAncestry && args[3] === current)
        throw Object.assign(new Error('Not ancestor'), { status: 1 });
      return f.run(command, args);
    };
    f.tags.delete('mobile-v1.2.0');
    return {
      ...f,
      run,
      author: () => {
        mobileAuthor = 'untrusted';
      },
      duplicateLater: () => {
        duplicate = true;
      },
      unrelated: () => {
        brokenAncestry = true;
      },
    };
  }
  const register = (f: ReturnType<typeof supersededFixture>, train = 'mobile') =>
    registerReleaseTags('register', head, { repository: 'example/repo', run: f.run, train });
  it('stops only mobile while independently reserving the server source', () => {
    const f = supersededFixture();
    expect(register(f)).toEqual([{ tag: 'mobile-v1.2.0', status: 'superseded', head: current }]);
    expect(f.writes).toHaveLength(0);
    expect(register(f, 'backend')).toEqual([{ tag: 'v3.0.0', sha: release }]);
    expect(f.tags.get('mobile-v1.2.0')).toBeUndefined();
  });
  it('keeps the all-train workflow barrier closed on the old snapshot', () => {
    const f = supersededFixture();
    f.tags.set('v3.0.0', release);
    expect(() =>
      registerReleaseTags('check', head, { repository: 'example/repo', run: f.run }),
    ).toThrow('not registered');
    expect(() =>
      registerReleaseTags('check', head, {
        repository: 'example/repo',
        run: f.run,
        train: 'backend',
      }),
    ).toThrow('all trains');
  });
  it('registers the exact later identity when running on current main', () => {
    const f = supersededFixture();
    const tags = new Map<string, string>();
    const run = (command: string, args: string[]) => {
      if (args[0] === 'ls-remote')
        return tags.has(args[3]!) ? `${tags.get(args[3]!)}\t${args[3]}` : '';
      if (command === 'gh' && args.includes('POST')) {
        tags.set('refs/tags/mobile-v1.2.0', wrong);
        return '{}';
      }
      return f.run(command, args);
    };
    expect(
      registerReleaseTags('register', current, {
        repository: 'example/repo',
        run,
        train: 'mobile',
      }),
    ).toEqual([{ tag: 'mobile-v1.2.0', sha: wrong }]);
  });
  it('never classifies authors, ambiguity, ancestry, tag conflicts or API errors as superseded', () => {
    const author = supersededFixture();
    author.author();
    expect(() => register(author)).toThrow('Unexpected author');
    const duplicate = supersededFixture();
    duplicate.duplicateLater();
    expect(() => register(duplicate)).toThrow('Ambiguous');
    const unrelated = supersededFixture();
    unrelated.unrelated();
    expect(() => register(unrelated)).toThrow('ancestry');
    const conflict = supersededFixture();
    conflict.tags.set('mobile-v1.2.0', release);
    expect(() => register(conflict)).toThrow('differs');
    const f = supersededFixture();
    expect(() =>
      registerReleaseTags('register', head, {
        repository: 'example/repo',
        train: 'mobile',
        run: (command, args) => {
          if (args[0] === 'fetch') throw new Error('fetch unavailable');
          return f.run(command, args);
        },
      }),
    ).toThrow('fetch unavailable');
  });
  it('propagates Git errors instead of assuming non-ancestry', () => {
    const f = fixture();
    expect(() =>
      registerReleaseTags('register', head, {
        repository: 'example/repo',
        train: 'backend',
        run: (command, args) => {
          if (args[0] === 'merge-base')
            throw Object.assign(new Error('missing object'), { status: 128 });
          return f.run(command, args);
        },
      }),
    ).toThrow('missing object');
  });
});

it('reproduces earlier version content and a later empty trusted merge using real Git ancestry', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'release-identity-'));
  try {
    const git = (args: string[]) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    git(['init', '-q']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.com']);
    // These manifests belong to the synthetic Git history, not the checkout.
    // Derive their paths by train so CI's managed-input guard does not mistake
    // fixture creation for a dependency on the repository's release versions.
    for (const [train, manifest] of [
      ['mobile', { 'apps/mobile': '1.77.0' }],
      ['backend', { '.': '4.55.0' }],
    ] as const) {
      writeFileSync(join(cwd, `.release-please-manifest.${train}.json`), JSON.stringify(manifest));
    }
    git(['add', '.']);
    git(['commit', '-qm', 'version content already on main']);
    const old = git(['rev-parse', 'HEAD']);
    const checkout = join(cwd, 'checkout');
    git(['clone', '--no-local', '-q', cwd, checkout]);
    git(['commit', '--allow-empty', '-qm', 'trusted mobile merge identity']);
    const current = git(['rev-parse', 'HEAD']);
    git(['remote', 'add', 'origin', cwd]);
    git(['update-ref', 'refs/tags/v4.55.0', old]);
    const run = (command: string, args: string[]) => {
      if (command === 'git')
        return execFileSync('git', args, {
          cwd: checkout,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
      if (args.includes('.object.sha')) return current;
      if (args.includes('POST')) {
        git([
          'update-ref',
          args[args.indexOf('-f') + 1]!.replace('ref=', ''),
          args.at(-1)!.replace('sha=', ''),
        ]);
        return '{}';
      }
      return JSON.stringify({
        merged_at: '2026-10-23',
        merge_commit_sha: current,
        user: { login: 'github-actions[bot]' },
        head: { ref: 'release-please--branches--main--components--mobile' },
      });
    };
    expect(
      registerReleaseTags('register', old, { repository: 'example/repo', run, train: 'mobile' }),
    ).toEqual([{ tag: 'mobile-v1.77.0', status: 'superseded', head: current }]);
    expect(git(['tag', '--list', 'mobile-*'])).toBe('');
    expect(
      registerReleaseTags('register', current, {
        repository: 'example/repo',
        run,
        train: 'mobile',
      }),
    ).toEqual([{ tag: 'mobile-v1.77.0', sha: current }]);
    expect(git(['rev-parse', 'mobile-v1.77.0'])).toBe(current);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
