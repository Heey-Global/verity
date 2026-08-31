import { describe, expect, it } from 'vitest';
import { LANGUAGE_SYSTEM_PROMPT } from './language.js';

describe('LANGUAGE_SYSTEM_PROMPT', () => {
  it('names the artifacts that must be English', () => {
    for (const artifact of [
      'commit messages',
      'branch names',
      'pull request titles',
      'code comments',
      'identifiers',
    ]) {
      expect(LANGUAGE_SYSTEM_PROMPT).toContain(artifact);
    }
  });

  it('keeps the chat reply in the operator language', () => {
    expect(LANGUAGE_SYSTEM_PROMPT).toMatch(/reply to the operator in the language they are using/i);
  });

  it('lets a repository override the default', () => {
    expect(LANGUAGE_SYSTEM_PROMPT).toContain('AGENTS.md');
    expect(LANGUAGE_SYSTEM_PROMPT).toMatch(/follow the repository/i);
  });
});
