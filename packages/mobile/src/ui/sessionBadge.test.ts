import { describe, expect, it } from 'vitest';
import type { SessionStatus } from '../api.js';
import { needsAttention, sessionBadge, showsSessionLabel } from './sessionBadge.js';

const ALL_STATUSES: SessionStatus[] = [
  'idle',
  'running',
  'awaiting_input',
  'awaiting_dependency',
  'completed',
  'crashed',
];

describe('sessionBadge', () => {
  it('gives every session status a non-empty badge', () => {
    for (const status of ALL_STATUSES) {
      const badge = sessionBadge(status);
      expect(badge.label.length).toBeGreaterThan(0);
      expect(['idle', 'active', 'attention', 'done', 'danger']).toContain(badge.tone);
    }
  });

  it('pulses only while the agent is actively working or awaiting input', () => {
    expect(sessionBadge('running').pulsing).toBe(true);
    expect(sessionBadge('awaiting_input').pulsing).toBe(true);
    expect(sessionBadge('idle').pulsing).toBe(false);
    expect(sessionBadge('completed').pulsing).toBe(false);
    expect(sessionBadge('crashed').pulsing).toBe(false);
  });

  it('maps failure and attention states to the expected tones', () => {
    expect(sessionBadge('crashed').tone).toBe('danger');
    expect(sessionBadge('awaiting_input').tone).toBe('attention');
    expect(sessionBadge('completed').tone).toBe('done');
    expect(sessionBadge('running').tone).toBe('active');
  });
});

describe('needsAttention', () => {
  it('flags awaiting_input and crashed for the attention queue', () => {
    expect(needsAttention('awaiting_input')).toBe(true);
    expect(needsAttention('crashed')).toBe(true);
  });

  it('does not flag working or terminal-ok states', () => {
    expect(needsAttention('running')).toBe(false);
    expect(needsAttention('idle')).toBe(false);
    expect(needsAttention('completed')).toBe(false);
    expect(needsAttention('awaiting_dependency')).toBe(false);
  });
});

describe('showsSessionLabel', () => {
  it('hides the label for working/implicit states (dot or absence conveys them)', () => {
    expect(showsSessionLabel('running')).toBe(false); // shown by the working dot
    expect(showsSessionLabel('completed')).toBe(false); // implicit: no dot
    expect(showsSessionLabel('idle')).toBe(false); // implicit: no dot
  });

  it('keeps the label for states worth actively noticing', () => {
    expect(showsSessionLabel('awaiting_input')).toBe(true);
    expect(showsSessionLabel('crashed')).toBe(true);
    expect(showsSessionLabel('awaiting_dependency')).toBe(true);
  });
});
