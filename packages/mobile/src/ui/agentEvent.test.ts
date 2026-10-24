import { describe, expect, it } from 'vitest';
import { agentEventDescriptor } from './agentEvent.js';

describe('agentEventDescriptor', () => {
  it('shows capacity retries as a neutral system notice', () => {
    expect(
      agentEventDescriptor({
        t: 'error',
        kind: 'model_capacity_retry',
        message: 'Retrying in 5 seconds (1/3).',
      }),
    ).toEqual({ kind: 'model-capacity', label: 'Retrying in 5 seconds (1/3).', tone: 'neutral' });
  });

  it('offers recovery after capacity retries are exhausted', () => {
    expect(
      agentEventDescriptor({
        t: 'error',
        kind: 'model_capacity',
        message: 'Selected model is at capacity.',
      }),
    ).toEqual({
      kind: 'model-capacity',
      label: 'Model temporarily unavailable',
      detail: 'Try again later or select a different model.',
      tone: 'warning',
    });
  });

  it('describes a compaction boundary (neutral, no detail)', () => {
    const d = agentEventDescriptor({ t: 'compaction', boundary: true });
    expect(d).toEqual({ kind: 'compaction', label: 'Context compacted', tone: 'neutral' });
    expect(d).not.toHaveProperty('detail');
  });

  it('keeps a short adapter diagnostic readable without a details section', () => {
    expect(agentEventDescriptor({ t: 'error', kind: 'parse_error', message: 'bad line' })).toEqual({
      kind: 'error',
      label: 'Agent error',
      detail: 'bad line',
      tone: 'danger',
    });
  });

  // A stderr tail as the headline is what flooded the chat: the operator saw
  // loader logs and session ids instead of what went wrong.
  it('keeps a multi-line diagnostic out of the headline', () => {
    const message = `first problem\n${'[session/load] noise\n'.repeat(200)}fatal: last line`;
    const d = agentEventDescriptor({ t: 'error', kind: 'parse_error', message });
    expect(d).toMatchObject({ label: 'Agent error', detail: 'first problem' });
    expect(d.technical?.startsWith('parse_error\n…')).toBe(true);
    expect(d.technical?.endsWith('fatal: last line')).toBe(true);
    expect(d.technical?.length).toBeLessThanOrEqual('parse_error\n…'.length + 2_000);
  });

  it.each([
    ['acp', 'Internal error: API Error: 502 {"type":"error","error":{"type":"api_error"}}'],
    ['run_failed', 'upstream connect error or disconnect/reset before headers'],
    [
      'crashed',
      'agent exited with code 1 without a terminal event: Error: 503 Service Unavailable',
    ],
    ['acp', 'Internal error: Overloaded'],
    ['run_failed', 'request failed: read ECONNRESET'],
  ])('reports a provider outage (%s) as retryable: %s', (kind, message) => {
    const d = agentEventDescriptor({ t: 'error', kind, message });
    expect(d).toMatchObject({
      kind: 'provider-unreachable',
      label: 'Model provider unreachable',
      tone: 'warning',
      action: 'retry',
    });
    expect(d.technical).toContain(message);
  });

  // A count that happens to start with 5 is not an HTTP status.
  it.each(['wrote 502 lines then failed', 'exceeded 500 tokens'])(
    'does not mistake a bare number for an outage: %s',
    (message) => {
      expect(agentEventDescriptor({ t: 'error', kind: 'acp', message }).kind).toBe('agent-stopped');
    },
  );

  it('summarizes a process crash and keeps its stderr behind details', () => {
    const message =
      'agent exited with code 1 without a terminal event: \u001b[31m[session/load] id=abc\u001b[0m';
    const d = agentEventDescriptor({ t: 'error', kind: 'crashed', message });
    expect(d).toEqual({
      kind: 'agent-stopped',
      label: 'Agent stopped unexpectedly',
      detail: 'The turn ended with an error.',
      tone: 'danger',
      action: 'retry',
      technical:
        'crashed\nagent exited with code 1 without a terminal event: [session/load] id=abc',
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

  it.each([
    'rate limit exceeded',
    'Your weekly quota has been reached. Internal error: request rejected',
    'Too many requests',
    "You've reached your Fable limit. Switch to another model to continue.",
    "Internal error: You've reached your Fable limit. Switch to another model to continue.",
    "agent exited with code 1 without a terminal event: [session/load] diagnostic data\nInternal error: You've reached your Fable limit. Switch to another model to continue.",
    "You've hit your session limit · resets 7:30pm (UTC)",
    "Internal error: You've hit your session limit · resets 7:30pm (UTC)",
  ])('shows a compact system notice for a provider limit: %s', (message) => {
    expect(agentEventDescriptor({ t: 'error', kind: 'run_failed', message })).toEqual({
      kind: 'limit-reached',
      label: 'Usage limit reached',
      tone: 'neutral',
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

it('describes durable task updates as an actionable Tasks row', () => {
  expect(
    agentEventDescriptor({
      t: 'tasks_updated',
      origin: 'agent',
      change: 'added',
      taskIds: ['one', 'two'],
    }),
  ).toMatchObject({ label: 'Agent planned 2 steps', action: 'tasks' });
  expect(
    agentEventDescriptor({
      t: 'tasks_updated',
      origin: 'user',
      change: 'completed',
      taskIds: ['one'],
    }),
  ).toMatchObject({ label: 'You completed 1 task', action: 'tasks' });
});
