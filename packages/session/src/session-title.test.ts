import { describe, expect, it } from 'vitest';
import {
  buildBranchPrompt,
  buildTitlePrompt,
  sanitizeBranchName,
  sanitizeTitle,
} from './session-title.js';

describe('buildTitlePrompt', () => {
  it('frames the digest into an instruction that asks for a short title', () => {
    const prompt = buildTitlePrompt('User: name sessions automatically');
    expect(prompt).toContain('at most 3 words');
    expect(prompt).toContain('User: name sessions automatically');
  });

  it('bounds the conversation length to 4000 chars', () => {
    const prompt = buildTitlePrompt('x'.repeat(10_000));
    expect(prompt).toContain('x'.repeat(4000));
    expect(prompt).not.toContain('x'.repeat(4001)); // conversation capped at 4000
  });

  it('returns an empty string for an empty digest (caller skips the model call)', () => {
    expect(buildTitlePrompt('   ')).toBe('');
  });
});

describe('buildBranchPrompt', () => {
  it('asks for a short English typed branch name', () => {
    const prompt = buildBranchPrompt('User: deutsche Session-Titel aber englische Branches');
    expect(prompt).toContain('<type>/<slug>');
    expect(prompt).toContain('English branch name');
    expect(prompt).toContain('deutsche Session-Titel');
  });

  it('returns an empty string for an empty digest', () => {
    expect(buildBranchPrompt('   ')).toBe('');
  });
});

describe('sanitizeTitle', () => {
  it('takes the first non-empty line and strips wrapping quotes + trailing punctuation', () => {
    expect(sanitizeTitle('\n  "Auth Refactor."  \n')).toBe('Auth Refactor');
    expect(sanitizeTitle('`Session Naming`')).toBe('Session Naming');
  });

  it('clamps to at most three words', () => {
    expect(sanitizeTitle('One Two Three Four Five')).toBe('One Two Three');
  });

  it('collapses inner whitespace', () => {
    expect(sanitizeTitle('Fix   Login\tBug')).toBe('Fix Login Bug');
  });

  it('returns undefined for empty or punctuation-only replies', () => {
    expect(sanitizeTitle('')).toBeUndefined();
    expect(sanitizeTitle('   \n  ')).toBeUndefined();
    expect(sanitizeTitle('"""')).toBeUndefined();
  });
});

describe('sanitizeBranchName', () => {
  it('keeps an allowed type and normalizes the slug', () => {
    expect(sanitizeBranchName('Fix/Branch Rename!')).toBe('fix/branch-rename');
  });

  it('clamps the slug to 40 characters', () => {
    expect(sanitizeBranchName(`feat/${'a'.repeat(80)}`)).toBe(`feat/${'a'.repeat(40)}`);
  });

  it('rejects unknown types and empty slugs', () => {
    expect(sanitizeBranchName('bug/login')).toBeUndefined();
    expect(sanitizeBranchName('fix/!!!')).toBeUndefined();
  });
});
