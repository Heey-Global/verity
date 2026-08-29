import { describe, expect, it } from 'vitest';
import { PULL_REQUEST_SYSTEM_PROMPT } from './pull-requests.js';

describe('PULL_REQUEST_SYSTEM_PROMPT', () => {
  it('forbids draft pull requests and names the escape hatch', () => {
    expect(PULL_REQUEST_SYSTEM_PROMPT).toMatch(/never a draft/i);
    expect(PULL_REQUEST_SYSTEM_PROMPT).toContain('--draft');
    expect(PULL_REQUEST_SYSTEM_PROMPT).toContain('gh pr ready');
  });
});
