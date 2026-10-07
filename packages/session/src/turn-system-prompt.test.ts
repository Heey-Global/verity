import { describe, expect, it } from 'vitest';
import { BREVITY_SYSTEM_PROMPT } from '@verity/events';
import { RESUME_SYSTEM_PROMPT, turnSystemPrompt } from './turn-system-prompt.js';

describe('communication instructions', () => {
  it.each([turnSystemPrompt(false), turnSystemPrompt(true), RESUME_SYSTEM_PROMPT])(
    'keeps concise replies and visible progress in every context',
    (prompt) => {
      // Existing sessions otherwise keep the old communication policy indefinitely.
      expect(prompt).toContain(BREVITY_SYSTEM_PROMPT);
      expect(prompt).toContain('a few sentences or short bullets');
      expect(prompt).toContain('60 seconds');
      expect(prompt).toContain('affected file paths');
      expect(prompt).toContain('analysis or explanation');
    },
  );
});

// A local project must receive the same managed-start contract as a GitHub project.
describe('development server instructions', () => {
  it.each([false, true])('requires managed starts for localProject=%s', (localProject) => {
    const prompt = turnSystemPrompt(localProject);
    expect(prompt).toContain('including plain requests such as "start the web server"');
    expect(prompt).toContain('Check `verity-dev-server list` first');
    expect(prompt).toContain('do not start a replacement directly');
    expect(prompt).toContain('must never substitute for add/start');
    expect(prompt).toContain('an existing direct process is not permission to bypass the tool');
    expect(prompt).toContain('enable Local or Shared online');
  });
});
