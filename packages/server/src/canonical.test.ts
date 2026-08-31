import { describe, expect, it } from 'vitest';
import { containerNameFor, parseOwnerRepo, slugifyProjectName } from './canonical.js';

describe('parseOwnerRepo (#174 §19.0)', () => {
  it('accepts a plain canonical owner/repo', () => {
    expect(parseOwnerRepo('example-org/example-repo')).toEqual({
      owner: 'example-org',
      repo: 'example-repo',
    });
  });

  it('rejects mixed-case owner/repo instead of silently normalising', () => {
    expect(parseOwnerRepo('Example-Org/Example-Repo')).toBeUndefined();
  });

  it('strips a .git suffix', () => {
    expect(parseOwnerRepo('example-org/example-repo.git')).toEqual({
      owner: 'example-org',
      repo: 'example-repo',
    });
  });

  it('strips a https://github.com/<owner>/<repo> URL prefix', () => {
    expect(parseOwnerRepo('https://github.com/example-org/example-repo')).toEqual({
      owner: 'example-org',
      repo: 'example-repo',
    });
  });

  it('accepts a pasted GitHub URL with surrounding whitespace and .git suffix', () => {
    expect(parseOwnerRepo(' https://github.com/example-org/example-repo.git ')).toEqual({
      owner: 'example-org',
      repo: 'example-repo',
    });
  });

  it('strips a git@github.com:<owner>/<repo> URL prefix', () => {
    expect(parseOwnerRepo('git@github.com:example-org/example-repo')).toEqual({
      owner: 'example-org',
      repo: 'example-repo',
    });
  });

  it('rejects an empty string', () => {
    expect(parseOwnerRepo('')).toBeUndefined();
  });

  it('rejects a bare /', () => {
    expect(parseOwnerRepo('/')).toBeUndefined();
  });

  it('rejects multi-segment paths (more than one /)', () => {
    expect(parseOwnerRepo('a/b/c')).toBeUndefined();
    expect(parseOwnerRepo('a/b/c/d')).toBeUndefined();
  });

  it('rejects a leading or trailing /', () => {
    expect(parseOwnerRepo('/a/b')).toBeUndefined();
    expect(parseOwnerRepo('a/b/')).toBeUndefined();
  });

  it('rejects a path-traversal-ish owner/repo (.. segment or . segment)', () => {
    expect(parseOwnerRepo('../..')).toBeUndefined();
    expect(parseOwnerRepo('./.')).toBeUndefined();
  });

  it('rejects an owner that begins/ends with -', () => {
    expect(parseOwnerRepo('-foo/bar')).toBeUndefined();
    expect(parseOwnerRepo('foo-/bar')).toBeUndefined();
  });

  it('rejects an owner with consecutive hyphens', () => {
    expect(parseOwnerRepo('foo--bar/baz')).toBeUndefined();
  });

  it('rejects an owner with disallowed chars (uppercase passing through case-fold, then non-alnum)', () => {
    // Already accepted in lowercase via toLowerCase; non-`[a-z0-9-]` after fold = reject.
    expect(parseOwnerRepo('foo.bar/baz')).toBeUndefined();
    expect(parseOwnerRepo('foo_bar/baz')).toBeUndefined();
  });

  it('rejects an owner longer than 39 chars', () => {
    expect(parseOwnerRepo(`${'a'.repeat(40)}/b`)).toBeUndefined();
  });

  it('accepts an owner that is exactly 39 chars', () => {
    expect(parseOwnerRepo(`${'a'.repeat(39)}/b`)).toEqual({
      owner: 'a'.repeat(39),
      repo: 'b',
    });
  });

  it('rejects an empty owner or repo', () => {
    expect(parseOwnerRepo('/b')).toBeUndefined();
    expect(parseOwnerRepo('a/')).toBeUndefined();
  });

  it('rejects a repo that begins/ends with . or - or _', () => {
    expect(parseOwnerRepo('a/.foo')).toBeUndefined();
    expect(parseOwnerRepo('a/-foo')).toBeUndefined();
    expect(parseOwnerRepo('a/_foo')).toBeUndefined();
    expect(parseOwnerRepo('a/foo.')).toBeUndefined();
    expect(parseOwnerRepo('a/foo-')).toBeUndefined();
    expect(parseOwnerRepo('a/foo_')).toBeUndefined();
  });

  it('rejects a repo with consecutive .', () => {
    expect(parseOwnerRepo('a/foo..bar')).toBeUndefined();
  });

  it('rejects a repo longer than 100 chars', () => {
    expect(parseOwnerRepo(`a/${'b'.repeat(101)}`)).toBeUndefined();
  });

  it('accepts a repo with internal . _ - (mixed)', () => {
    expect(parseOwnerRepo('a/b.c_d-e')).toEqual({ owner: 'a', repo: 'b.c_d-e' });
  });
});

describe('containerNameFor (#174 §19.0)', () => {
  it('derives verity-<owner>--<repo> hyphen-slug form', () => {
    expect(containerNameFor({ owner: 'example-org', repo: 'example-repo' })).toBe(
      'verity-example-org--example-repo',
    );
  });

  it('preserves . and _ in repo so distinct GitHub repos do not collide', () => {
    expect(containerNameFor({ owner: 'foo', repo: 'b.c_d-e' })).toBe('verity-foo--b.c_d-e');
  });

  it('uses a double-hyphen owner/repo separator', () => {
    expect(containerNameFor({ owner: 'foo', repo: 'bar-baz' })).toBe('verity-foo--bar-baz');
  });
});

describe('slugifyProjectName (projects created without GitHub)', () => {
  it('lowercases and hyphenates an operator-typed name', () => {
    expect(slugifyProjectName('My New Project')).toBe('my-new-project');
  });

  it('normalises rather than rejecting — unlike parseOwnerRepo', () => {
    expect(slugifyProjectName('Ünsere App!!')).toBe('nsere-app');
    expect(parseOwnerRepo('local/Ünsere App!!')).toBeUndefined();
  });

  it('keeps the . _ - that validRepo allows internally', () => {
    expect(slugifyProjectName('api.v2_beta-1')).toBe('api.v2_beta-1');
  });

  it('collapses the separator runs the substitution creates', () => {
    expect(slugifyProjectName('a   /  b')).toBe('a-b');
  });

  it('trims leading/trailing separators validRepo forbids', () => {
    expect(slugifyProjectName('  ---my project---  ')).toBe('my-project');
    expect(slugifyProjectName('.hidden.')).toBe('hidden');
  });

  it('truncates to the 100-char repo limit without a trailing separator', () => {
    const slug = slugifyProjectName(`${'a'.repeat(99)} bbb`);
    expect(slug).toBe('a'.repeat(99));
    expect(slug!.length).toBeLessThanOrEqual(100);
  });

  it('returns undefined when nothing legal survives', () => {
    expect(slugifyProjectName('!!!')).toBeUndefined();
    expect(slugifyProjectName('   ')).toBeUndefined();
  });

  it('produces a slug the shared project parser accepts as a repo', () => {
    const slug = slugifyProjectName('My New Project');
    expect(parseOwnerRepo(`local/${slug!}`)).toEqual({ owner: 'local', repo: slug });
  });
});
