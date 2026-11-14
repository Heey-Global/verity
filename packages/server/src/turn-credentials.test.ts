import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createTurnCredentials,
  TURN_CAPABILITY_PATTERN,
  turnFitsSandbox,
} from './turn-credentials.js';

const binding = { projectId: 'p1', sessionId: 's1', turnId: 't1', userId: 'lena' };

describe('turn credentials', () => {
  it('names the turn and its person, only inside its own project', () => {
    const turns = createTurnCredentials();
    const token = turns.issue(binding);
    // The shape the sandbox helpers and the broker accept; anything else is dropped there.
    expect(token).toMatch(TURN_CAPABILITY_PATTERN);
    expect(turns.resolve({ projectId: 'p1', token })).toEqual(binding);
    expect(turns.resolve({ projectId: 'p2', token })).toBeUndefined();
    // A different last character, whatever the random one was.
    const altered = `${token.slice(0, 42)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect(turns.resolve({ projectId: 'p1', token: altered })).toBeUndefined();
  });

  it('keeps a turn without an initiator personless', () => {
    const turns = createTurnCredentials();
    const token = turns.issue({ ...binding, userId: null });
    expect(turns.resolve({ projectId: 'p1', token })?.userId).toBeNull();
  });

  it('stops working when the turn settles, expires or its project is revoked', () => {
    let now = 0;
    const turns = createTurnCredentials({ now: () => now, ttlMs: 1_000 });
    const released = turns.issue(binding);
    turns.release(released);
    expect(turns.resolve({ projectId: 'p1', token: released })).toBeUndefined();

    const expiring = turns.issue(binding);
    now = 1_000;
    expect(turns.resolve({ projectId: 'p1', token: expiring })).toBeUndefined();

    const revoked = turns.issue(binding);
    const other = turns.issue({ ...binding, projectId: 'p2' });
    turns.revokeProject('p1');
    expect(turns.resolve({ projectId: 'p1', token: revoked })).toBeUndefined();
    expect(turns.resolve({ projectId: 'p2', token: other })?.projectId).toBe('p2');
  });

  it('refuses to grow without bound', () => {
    const turns = createTurnCredentials({ capacity: 2 });
    turns.issue(binding);
    turns.issue(binding);
    expect(() => turns.issue(binding)).toThrow(/capacity/u);
  });
});

describe('turnFitsSandbox', () => {
  // A badge read out of one sandbox must prove nothing in another: a person's
  // badge only in their own sandbox, a badge without a person only in the
  // project's original sandbox, where such turns run.
  it('accepts a badge only in the sandbox it belongs to', () => {
    const own = { userId: 'lena', projectDefault: false };
    const other = { userId: 'bob', projectDefault: false };
    const original = { userId: 'admin', projectDefault: true };
    expect(turnFitsSandbox({ userId: 'lena' }, own)).toBe(true);
    expect(turnFitsSandbox({ userId: 'lena' }, other)).toBe(false);
    expect(turnFitsSandbox({ userId: 'lena' }, original)).toBe(false);
    expect(turnFitsSandbox({ userId: null }, original)).toBe(true);
    expect(turnFitsSandbox({ userId: null }, own)).toBe(false);
  });
});

describe('turn credentials across a Server restart', () => {
  // Supervised turns survive a restart; their badges must too, or every
  // recovered turn loses signing and pushing for the rest of its run.
  it('resolves a live badge after a restart, and never stores the badge itself', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verity-turn-badges-'));
    const persistPath = join(dir, 'badges.json');
    try {
      const before = createTurnCredentials({ persistPath });
      const binding = { projectId: 'p1', sessionId: 's1', turnId: 't1', userId: 'lena' };
      const token = before.issue(binding);
      const released = before.issue({ ...binding, turnId: 't2' });
      before.release(released);
      expect(readFileSync(persistPath, 'utf8')).not.toContain(token);

      const after = createTurnCredentials({ persistPath });
      expect(after.resolve({ projectId: 'p1', token })).toEqual(binding);
      expect(after.resolve({ projectId: 'p1', token: released })).toBeUndefined();
      // Expired badges do not come back either.
      const later = createTurnCredentials({ persistPath, now: () => Date.now() + 26 * 3_600_000 });
      expect(later.resolve({ projectId: 'p1', token })).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
