import { describe, expect, it } from 'vitest';
import {
  APP_HELP_SYSTEM_PROMPT,
  BREVITY_SYSTEM_PROMPT,
  LOCAL_PROJECT_SYSTEM_PROMPT,
  PULL_REQUEST_SYSTEM_PROMPT,
} from '@verity/events';
import { RESUME_SYSTEM_PROMPT, turnSystemPrompt } from './turn-system-prompt.js';

describe('communication instructions', () => {
  it.each([
    turnSystemPrompt('github'),
    turnSystemPrompt('forgejo'),
    turnSystemPrompt('local'),
    RESUME_SYSTEM_PROMPT,
  ])('keeps concise replies and visible progress in every context', (prompt) => {
    // Existing sessions otherwise keep the old communication policy indefinitely.
    expect(prompt).toContain(BREVITY_SYSTEM_PROMPT);
    expect(prompt).toContain('a few sentences or short bullets');
    expect(prompt).toContain('60 seconds');
    expect(prompt).toContain('affected file paths');
    expect(prompt).toContain('analysis or explanation');
  });
});

// A local project must receive the same managed-start contract as a GitHub project.
describe('development server instructions', () => {
  it.each(['github', 'forgejo', 'local'] as const)(
    'requires managed starts for %s projects',
    (host) => {
      const prompt = turnSystemPrompt(host);
      expect(prompt).toContain('including plain requests such as "start the web server"');
      expect(prompt).toContain('Check `verity-dev-server list` first');
      expect(prompt).toContain('do not start a replacement directly');
      expect(prompt).toContain('must never substitute for add/start');
      expect(prompt).toContain('an existing direct process is not permission to bypass the tool');
      expect(prompt).toContain('enable Local or Shared online');
    },
  );
});

// Without the section a fresh session answers "where do I connect GitHub?" from
// memory and describes a path instead of handing over a link the app can open.
// Resumed contexts are left out on purpose: they already carry it from their
// fresh turn, and the tool description reaches them through tools/list.
describe('app help instructions', () => {
  it.each(['github', 'forgejo', 'local'] as const)(
    'points fresh contexts at the help tool for %s projects',
    (host) => {
      expect(turnSystemPrompt(host)).toContain(APP_HELP_SYSTEM_PROMPT);
    },
  );

  it('keeps the resume prompt free of it', () => {
    expect(RESUME_SYSTEM_PROMPT).not.toContain(APP_HELP_SYSTEM_PROMPT);
  });
});

// An agent told to use `gh` on Forgejo fails on its first pull request, and one
// told to use `verity-repo` on GitHub loses the proven workflow; each host must
// get exactly its own instructions.
describe('pull request instructions per code host', () => {
  it('keeps gh for GitHub projects', () => {
    const prompt = turnSystemPrompt('github');
    expect(prompt).toContain(PULL_REQUEST_SYSTEM_PROMPT);
    expect(prompt).not.toContain('verity-repo pr create');
  });

  it('sends Forgejo projects to verity-repo and away from gh', () => {
    const prompt = turnSystemPrompt('forgejo');
    expect(prompt).not.toContain(PULL_REQUEST_SYSTEM_PROMPT);
    expect(prompt).not.toContain(LOCAL_PROJECT_SYSTEM_PROMPT);
    expect(prompt).toContain("This project's code host is Forgejo");
    expect(prompt).toContain('verity-repo pr create');
    expect(prompt).toContain('verity-repo pr ready');
    expect(prompt).not.toContain('gh pr ready');
  });

  it('gives local projects no remote workflow at all', () => {
    const prompt = turnSystemPrompt('local');
    expect(prompt).toContain(LOCAL_PROJECT_SYSTEM_PROMPT);
    expect(prompt).not.toContain(PULL_REQUEST_SYSTEM_PROMPT);
    expect(prompt).not.toContain('verity-repo pr create');
  });
});
