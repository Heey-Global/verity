import { describe, expect, it } from 'vitest';
import { TERMINOLOGY_SYSTEM_PROMPT } from './terminology.js';

describe('TERMINOLOGY_SYSTEM_PROMPT', () => {
  it('defines operator as internal vocabulary and requires direct user-facing address', () => {
    expect(TERMINOLOGY_SYSTEM_PROMPT).toMatch(/operator.*person using Verity/i);
    expect(TERMINOLOGY_SYSTEM_PROMPT).toMatch(/internal role/i);
    expect(TERMINOLOGY_SYSTEM_PROMPT).toMatch(/address that person as "you"/i);
  });
});
