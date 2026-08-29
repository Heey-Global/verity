import { describe, expect, it } from 'vitest';
import { DELEGATION_SYSTEM_PROMPT } from './delegation.js';

describe('DELEGATION_SYSTEM_PROMPT', () => {
  it('instructs delegating heavy reading to a sub-agent', () => {
    expect(DELEGATION_SYSTEM_PROMPT).toMatch(/Task\/Agent tool/);
    expect(DELEGATION_SYSTEM_PROMPT).toMatch(/many\/large files/i);
  });

  it('asks for concise file references instead of bulky parent-context reads', () => {
    expect(DELEGATION_SYSTEM_PROMPT).toMatch(/concise summary/i);
    expect(DELEGATION_SYSTEM_PROMPT).toMatch(/file:line/);
    expect(DELEGATION_SYSTEM_PROMPT).toMatch(/parent context/i);
  });

  it('carves out the anti-pattern: no sub-agents for trivial lookups', () => {
    // The targeted-only rule is the load-bearing part — without it the directive
    // would encourage wasteful sub-agent spawns for single-file lookups.
    expect(DELEGATION_SYSTEM_PROMPT).toMatch(/Do not delegate trivial/i);
  });
});
