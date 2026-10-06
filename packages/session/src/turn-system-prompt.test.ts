import { describe, expect, it } from 'vitest';
import { turnSystemPrompt } from './turn-system-prompt.js';

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
