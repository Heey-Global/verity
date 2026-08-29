import { REPO_CONVENTIONS_SYSTEM_PROMPT } from '@verity/events';
import { describe, expect, it } from 'vitest';
import { githubRefUrl, parseBranchIssue } from './branchRef.js';

describe('parseBranchIssue', () => {
  it('parses the leading issue number from a <type>/<issue>-<slug> branch', () => {
    expect(parseBranchIssue('feat/122-preview-branches')).toBe(122);
    expect(parseBranchIssue('fix/130-keyboard-gap')).toBe(130);
    expect(parseBranchIssue('chore/7-bump-deps')).toBe(7);
  });

  it('returns null for a branch with no leading issue number', () => {
    expect(parseBranchIssue('main')).toBeNull();
    expect(parseBranchIssue('agent/d0626bd8')).toBeNull(); // auto-spawn branch, hex id
    expect(parseBranchIssue('feat/preview-branches')).toBeNull(); // no number
  });

  it('requires the trailing dash so a bare <type>/<issue> does not half-match', () => {
    expect(parseBranchIssue('feat/122')).toBeNull();
  });

  it('only matches a lowercase type prefix', () => {
    expect(parseBranchIssue('Feat/122-x')).toBeNull();
    expect(parseBranchIssue('123-x')).toBeNull(); // no type prefix at all
  });

  it('handles undefined (branch not loaded yet) without throwing', () => {
    expect(parseBranchIssue(undefined)).toBeNull();
  });

  /**
   * The naming rule is shipped to sessions in repositories without an `AGENTS.md`
   * as a runtime prompt fragment. Its worked examples are what an agent copies, so
   * they have to survive this parser: an example that does not parse teaches a
   * branch name that silently costs the operator the Issue chip. Asserted here
   * rather than in `packages/events` because the dependency runs mobile → events,
   * and checking a prompt example against a re-typed regex proves nothing.
   */
  it('accepts every branch example the shipped conventions prompt gives', () => {
    // Scraped AND listed. Scraping alone would silently skip an example the
    // pattern failed to match — and the prompt deliberately also allows
    // issue-less branches, which this parser rejects by design. Requiring the
    // scraped set to equal the list means a new example fails here until it has
    // been decided which of the two it is.
    // Scoped to the branch-naming paragraph and anchored on the branch types.
    // `docs/`, `test/` and `style/` are also ordinary directory names, so a
    // scrape over the whole prompt would fail on a quoted file path as if a
    // branch example had broken.
    const branchParagraph = REPO_CONVENTIONS_SYSTEM_PROMPT.split('\n\n').find((paragraph) =>
      paragraph.includes('<type>/<issue>-<slug>'),
    );
    expect(branchParagraph).toBeDefined();
    const found = [
      ...(branchParagraph ?? '').matchAll(
        /`((?:feat|fix|chore|refactor|docs|style|test)\/[^\s`]+)`/g,
      ),
    ].map((match) => match[1]);

    expect(found).toEqual(['feat/122-preview-branches', 'fix/130-keyboard-gap']);
    for (const example of found) {
      expect(parseBranchIssue(example)).toBeGreaterThan(0);
    }
  });

  it('accepts every branch type that prompt lists', () => {
    // The worked examples only cover feat and fix. The list is the normative
    // part, so a type on it that this parser rejects would ship as advice that
    // silently costs the Issue chip — the failure the test above exists for.
    const types = /Branch types: ([^.]+)\./.exec(REPO_CONVENTIONS_SYSTEM_PROMPT)?.[1];
    expect(types).toBeDefined();
    const listed = [...(types ?? '').matchAll(/`([a-z]+)`/g)].map((match) => match[1]);

    expect(listed).toEqual(['feat', 'fix', 'chore', 'refactor', 'docs', 'style', 'test']);
    for (const type of listed) {
      expect(parseBranchIssue(`${String(type)}/42-some-slug`)).toBe(42);
    }
  });
});

describe('githubRefUrl (#161)', () => {
  const id = { owner: 'Example-Org', repo: 'Example-Repo' };

  it('builds the canonical issue and PR URLs', () => {
    expect(githubRefUrl('issue', id, 161)).toBe(
      'https://github.com/Example-Org/Example-Repo/issues/161',
    );
    expect(githubRefUrl('pr', id, 127)).toBe(
      'https://github.com/Example-Org/Example-Repo/pull/127',
    );
  });

  it('returns null when owner or repo is missing (no GitHub remote / older server)', () => {
    expect(githubRefUrl('issue', { owner: undefined, repo: 'Example-Repo' }, 161)).toBeNull();
    expect(githubRefUrl('pr', { owner: 'Example-Org', repo: undefined }, 127)).toBeNull();
    expect(githubRefUrl('issue', {}, 161)).toBeNull();
  });

  it('returns null when owner or repo is the empty string', () => {
    expect(githubRefUrl('issue', { owner: '', repo: 'Example-Repo' }, 161)).toBeNull();
    expect(githubRefUrl('pr', { owner: 'Example-Org', repo: '' }, 127)).toBeNull();
  });

  it('returns null for a missing or non-positive number (no chip to link)', () => {
    expect(githubRefUrl('pr', id, null)).toBeNull();
    expect(githubRefUrl('pr', id, undefined)).toBeNull();
    expect(githubRefUrl('issue', id, 0)).toBeNull();
    expect(githubRefUrl('issue', id, -5)).toBeNull();
    expect(githubRefUrl('issue', id, 1.5)).toBeNull();
  });

  it('percent-encodes owner/repo so an unusual remote name cannot break the URL', () => {
    expect(githubRefUrl('issue', { owner: 'a b', repo: 'c/d' }, 1)).toBe(
      'https://github.com/a%20b/c%2Fd/issues/1',
    );
  });
});
