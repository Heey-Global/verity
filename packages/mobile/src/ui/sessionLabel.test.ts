import { describe, expect, it } from 'vitest';
import { sessionLabel } from './sessionLabel.js';

describe('sessionLabel', () => {
  it('prefers the operator-assigned name when set', () => {
    expect(sessionLabel({ name: 'refactor auth', worktree: 'wt-1', sessionId: 's1' })).toBe(
      'refactor auth',
    );
  });

  it('falls back to the worktree when there is no name', () => {
    expect(sessionLabel({ name: null, worktree: 'agent/foo-s1', sessionId: 's1' })).toBe('foo-s1');
  });

  it('shortens generated agent worktrees instead of showing a path', () => {
    expect(
      sessionLabel({
        name: null,
        worktree: '/data/dev/heey-global-k8s/.verity-sessions/agent-b3f0abcd1234',
        sessionId: 's1',
      }),
    ).toBe('Session b3f0abcd');
  });

  it('falls back to the session id when name and worktree are empty', () => {
    expect(sessionLabel({ name: null, worktree: '', sessionId: 's1' })).toBe('s1');
  });

  it('ignores a whitespace-only name', () => {
    expect(sessionLabel({ name: '   ', worktree: 'wt-1', sessionId: 's1' })).toBe('wt-1');
  });
});
