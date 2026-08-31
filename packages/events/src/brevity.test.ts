import { describe, expect, it } from 'vitest';
import { BREVITY_SYSTEM_PROMPT } from './brevity.js';

describe('BREVITY_SYSTEM_PROMPT', () => {
  it('tells the agent to lead with the outcome and skip preambles', () => {
    expect(BREVITY_SYSTEM_PROMPT).toMatch(/lead with the outcome/i);
    expect(BREVITY_SYSTEM_PROMPT).toMatch(/skip preambles/i);
  });

  it('says to summarize long sub-agent reports and point to file:line', () => {
    // The load-bearing part: a long sub-agent report must be summarized, not
    // pasted back verbatim as the operator-facing reply (the reported symptom).
    expect(BREVITY_SYSTEM_PROMPT).toMatch(/sub-agent/i);
    expect(BREVITY_SYSTEM_PROMPT).toMatch(/summarize/i);
    expect(BREVITY_SYSTEM_PROMPT).toMatch(/file:line/);
  });

  it('carves out the exception: verbatim only when explicitly asked', () => {
    expect(BREVITY_SYSTEM_PROMPT).toMatch(/verbatim only when the operator explicitly asks/i);
  });
});
