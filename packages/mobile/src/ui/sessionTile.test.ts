import { describe, expect, it } from 'vitest';
import type { SessionPr, SessionSummary } from '../api.js';
import { markerAttention } from './attention.js';
import { sessionAgentMark, sessionTile } from './sessionTile.js';

type TileInput = Parameters<typeof sessionTile>[0];

const openPr = (over: Partial<SessionPr> = {}): SessionPr => ({
  phase: 'open',
  pipeline: 'running',
  mergeable: null,
  ...over,
});

const withPr = (pr: SessionPr, status: SessionSummary['status'] = 'idle'): TileInput => ({
  status,
  pr,
});

describe('sessionTile', () => {
  it.each([
    [
      'a conflict',
      openPr({ pipeline: 'unknown', mergeable: false, mergeState: 'dirty' }),
      'problem',
      'conflict',
    ],
    ['failed checks', openPr({ pipeline: 'failure', mergeable: false }), 'problem', 'failed'],
    ['a blocked merge', openPr({ pipeline: 'success', mergeable: false }), 'problem', 'conflict'],
    ['a mergeable PR', openPr({ pipeline: 'success', mergeable: true }), 'ready', 'passed'],
    [
      'settling mergeability',
      openPr({ pipeline: 'success', mergeable: null }),
      'quiet',
      'checking',
    ],
    ['running checks', openPr({ pipeline: 'running' }), 'progress', 'running'],
  ] as const)('marks an open PR with %s', (_, pr, tone, result) => {
    const tile = sessionTile(withPr(pr));
    expect(tile).toMatchObject({ glyph: 'pull_request', tone, result });
    // The tile speaks the same words as the row's subtitle, which reads them from
    // the attention model; a tile with its own wording would contradict it.
    expect(tile.label).toBe(markerAttention({ status: 'idle', pr })[0]?.label);
  });

  it('draws no verdict it cannot know', () => {
    // pr_unknown: no checks reported and mergeability unknown. A ✓ or ✕ here would
    // be a guess, so the tile is the bare, quiet PR glyph.
    const tile = sessionTile(withPr(openPr({ pipeline: 'unknown', mergeable: null })));
    expect(tile).toEqual({ glyph: 'pull_request', tone: 'quiet', label: 'PR status unavailable' });
  });

  it('keeps the PR verdict when the agent is also waiting for the operator', () => {
    // `question` is the top mark's job; the tile must not lose its PR verdict to it.
    const pr = openPr({ pipeline: 'failure', mergeable: false });
    expect(sessionTile(withPr(pr, 'awaiting_input'))).toMatchObject({ result: 'failed' });
  });

  it('shows a merged PR without a verdict mark', () => {
    expect(sessionTile(withPr({ ...openPr(), phase: 'merged' }))).toEqual({
      glyph: 'merged',
      tone: 'quiet',
      label: 'Pull request merged',
    });
  });

  it('prefers the full pull request phase over the summary projection', () => {
    // The full record is what the subtitle's "merged" reads; the projection can lag.
    const tile = sessionTile({
      status: 'idle',
      pr: openPr(),
      pullRequest: {
        number: 7,
        title: 't',
        url: 'u',
        phase: 'merged',
        pipeline: 'success',
        checks: { completed: 1, total: 1, successful: 1, failed: 0, pending: 0 },
        mergeable: null,
      },
    });
    expect(tile.glyph).toBe('merged');
  });

  it('falls back to automation, then to the neutral session tile', () => {
    expect(sessionTile({ status: 'idle', automation: { status: 'enabled' } })).toEqual({
      glyph: 'automation',
      tone: 'quiet',
      label: 'Automation',
    });
    expect(sessionTile({ status: 'idle', automation: { status: 'paused' } }).label).toBe(
      'Automation paused',
    );
    expect(sessionTile({ status: 'running' })).toEqual({
      glyph: 'session',
      tone: 'quiet',
      label: 'Session',
    });
  });

  it('lets a pull request outrank automation', () => {
    const tile = sessionTile({ ...withPr(openPr()), automation: { status: 'enabled' } });
    expect(tile.glyph).toBe('pull_request');
  });
});

describe('sessionAgentMark', () => {
  it('ranks waiting for the operator over working over unread', () => {
    expect(sessionAgentMark({ status: 'awaiting_input', working: true, unread: true })).toBe(
      'question',
    );
    expect(sessionAgentMark({ status: 'running', working: true, unread: true })).toBe('working');
    expect(sessionAgentMark({ status: 'idle', working: false, unread: true })).toBe('unread');
    expect(sessionAgentMark({ status: 'idle', working: false, unread: false })).toBeUndefined();
  });
});
