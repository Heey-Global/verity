import { describe, expect, it } from 'vitest';
import { MEMORY_SYSTEM_PROMPT } from './memory.js';

describe('MEMORY_SYSTEM_PROMPT', () => {
  it('gives every fresh context the self-contained memory command', () => {
    expect(MEMORY_SYSTEM_PROMPT).toContain('verity-memory append');
    expect(MEMORY_SYSTEM_PROMPT).toMatch(/remember or save durable project information/i);
    expect(MEMORY_SYSTEM_PROMPT).not.toMatch(/ADR\s+0008/i);
  });

  it('keeps durable memory concise and safe', () => {
    expect(MEMORY_SYSTEM_PROMPT).toMatch(/in English regardless of the conversation language/i);
    expect(MEMORY_SYSTEM_PROMPT).toMatch(/decisions, conventions, or gotchas/i);
    expect(MEMORY_SYSTEM_PROMPT).toMatch(/never secrets or transient state/i);
    expect(MEMORY_SYSTEM_PROMPT).toMatch(/future fresh sessions/i);
  });

  it('steers agents away from their own backend memory', () => {
    // The prompt must forbid saving project notes in a backend-private store (the
    // gap that let an agent write to ~/.claude instead of Verity memory).
    expect(MEMORY_SYSTEM_PROMPT).toMatch(/never save them in your backend's own memory/i);
    expect(MEMORY_SYSTEM_PROMPT).toContain('~/.claude');
    // And it must say what to do when the broker is unavailable.
    expect(MEMORY_SYSTEM_PROMPT).toMatch(/broker is unconfigured/i);
  });
});
