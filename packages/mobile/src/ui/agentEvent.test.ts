import { describe, expect, it } from 'vitest';
import { agentEventDescriptor } from './agentEvent.js';

describe('agentEventDescriptor', () => {
  it('describes a compaction boundary (neutral, no detail)', () => {
    const d = agentEventDescriptor({ t: 'compaction', boundary: true });
    expect(d).toEqual({ kind: 'compaction', label: 'Context compacted', tone: 'neutral' });
    expect(d).not.toHaveProperty('detail');
  });

  it('describes an error event (danger, message as label, kind as detail)', () => {
    expect(agentEventDescriptor({ t: 'error', kind: 'parse_error', message: 'bad line' })).toEqual({
      kind: 'error',
      label: 'bad line',
      detail: 'parse_error',
      tone: 'danger',
    });
  });

  it('turns an expired Claude OAuth session into a login recovery action', () => {
    expect(
      agentEventDescriptor({
        t: 'error',
        kind: 'run_failed',
        message: 'Failed to authenticate: OAuth session expired and could not be refreshed',
      }),
    ).toEqual({
      kind: 'authentication-required',
      label: 'Claude login expired',
      detail: 'Sign in again to continue this session.',
      tone: 'danger',
      action: 'claude-login',
    });
  });

  it('describes an interrupted event without assuming who stopped it', () => {
    expect(agentEventDescriptor({ t: 'interrupted' })).toEqual({
      kind: 'interrupted',
      label: 'Turn interrupted',
      tone: 'warning',
    });
  });

  it('describes a merged event (neutral, "Merged PR #N")', () => {
    expect(agentEventDescriptor({ t: 'merged', number: 233 })).toEqual({
      kind: 'merged',
      label: 'Merged PR #233',
      tone: 'neutral',
    });
  });

  it('describes a raw passthrough event', () => {
    expect(
      agentEventDescriptor({ t: 'raw', backend: 'claude-code', payload: { x: 1 } }),
    ).toMatchObject({
      kind: 'raw',
      label: 'Unrecognized event',
      detail: 'claude-code',
      tone: 'neutral',
    });
  });

  // Without the type the row is unactionable: every unmapped stream type looks
  // identical, so a type a new CLI release starts emitting cannot be told apart.
  it('names the unmapped stream type when the payload carries one', () => {
    expect(
      agentEventDescriptor({
        t: 'raw',
        backend: 'claude-code',
        payload: { type: 'tool_progress', id: 'x' },
      }),
    ).toMatchObject({ kind: 'raw', detail: 'claude-code: tool_progress' });
  });

  it.each([
    ['a non-object payload', 42],
    ['a null payload', null],
    ['a payload without a type', { id: 'x' }],
    ['a non-string type', { type: 7 }],
    ['an empty type', { type: '' }],
  ])('falls back to the backend for %s', (_case, payload) => {
    expect(agentEventDescriptor({ t: 'raw', backend: 'claude-code', payload })).toMatchObject({
      detail: 'claude-code',
    });
  });

  // The string is rendered and nothing upstream constrains its shape.
  it('strips layout-breaking characters and caps a hostile type', () => {
    const descriptor = agentEventDescriptor({
      t: 'raw',
      backend: 'claude-code',
      payload: { type: `a\n[31mb${'c'.repeat(200)}` },
    });

    const type = descriptor.detail?.slice('claude-code: '.length);
    expect(type).toMatch(/^[\w.:-]+$/u);
    expect(type).toHaveLength(64);
  });

  it('falls back gracefully for a non-lifecycle event (defensive default)', () => {
    const d = agentEventDescriptor({ t: 'text', delta: 'hi' });
    expect(d).toEqual({ kind: 'text', label: 'text', tone: 'neutral' });
  });
});
