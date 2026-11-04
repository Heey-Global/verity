import {
  SESSION_PROJECTION_EVENT_TYPES,
  sessionProjectionEvents,
  type AgentEvent,
} from '@verity/events';
import { describe, expect, it } from 'vitest';

import {
  openChoicesFromProjection,
  pendingPermissionRequestsFromProjection,
  PERMISSION_INPUT_MAX_BYTES,
} from './session-inbox-facts.js';

const prompt: AgentEvent = { t: 'prompt', text: 'Build the form' };
const steer: AgentEvent = { t: 'prompt', text: 'Use the imprint text', steered: true };
const choices: AgentEvent = {
  t: 'choices',
  question: 'Which validation library?',
  options: [{ label: 'Zod', recommended: true }, { label: 'Valibot' }],
};
const completed: AgentEvent = { t: 'status', state: 'completed' };
const permission = (id: string, input: unknown): AgentEvent => ({
  t: 'permission',
  id,
  tool: 'verity_http_request',
  input,
  riskClass: 'ask',
});

describe('openChoicesFromProjection', () => {
  it('offers the current turn’s choices until a prompt answers them', () => {
    const open = [prompt, choices, completed];
    expect(openChoicesFromProjection(open, 'completed', false)).toEqual({
      question: 'Which validation library?',
      options: [{ label: 'Zod', recommended: true }, { label: 'Valibot' }],
    });
    // Answering a choice IS the next prompt; a stale block must not reappear.
    expect(
      openChoicesFromProjection([...open, { t: 'prompt', text: 'Zod' }], 'completed', false),
    ).toBeUndefined();
  });

  it('does not treat steering as an answer', () => {
    expect(
      openChoicesFromProjection([prompt, choices, steer], 'completed', false)?.options,
    ).toEqual([{ label: 'Zod', recommended: true }, { label: 'Valibot' }]);
  });

  it('withholds the question while the session works, is busy or crashed', () => {
    const events = [prompt, choices];
    expect(openChoicesFromProjection(events, 'running', false)).toBeUndefined();
    expect(openChoicesFromProjection(events, 'crashed', false)).toBeUndefined();
    expect(openChoicesFromProjection(events, 'completed', true)).toBeUndefined();
    expect(openChoicesFromProjection(events, 'awaiting_input', false)).toBeDefined();
  });

  it('reads an event kind the overview projection actually loads', () => {
    // The summary only ever sees the narrowed slice. If `choices` dropped out of
    // the projection set, every open question would silently vanish from Home.
    expect(SESSION_PROJECTION_EVENT_TYPES).toContain('choices');
    const narrowed = sessionProjectionEvents([prompt, { t: 'text', delta: 'Pick one' }, choices]);
    expect(openChoicesFromProjection(narrowed, 'completed', false)).toBeDefined();
  });
});

describe('pendingPermissionRequestsFromProjection', () => {
  it('describes only prompts the conductor still has open, in its order', () => {
    const events = [
      prompt,
      permission('old', { url: 'https://a.example' }),
      permission('a', { url: 'https://api.exa.ai' }),
      permission('b', { host: 'example.org' }),
    ];
    expect(pendingPermissionRequestsFromProjection(events, ['b', 'a'])).toEqual([
      {
        toolUseId: 'b',
        tool: 'verity_http_request',
        riskClass: 'ask',
        input: { host: 'example.org' },
      },
      {
        toolUseId: 'a',
        tool: 'verity_http_request',
        riskClass: 'ask',
        input: { url: 'https://api.exa.ai' },
      },
    ]);
  });

  it('omits ids without an event in the current turn instead of guessing', () => {
    // A linked-session approval has an id but no permission event; a prompt from
    // an earlier turn must not be revived by a matching id.
    const events = [permission('earlier', {}), prompt];
    expect(pendingPermissionRequestsFromProjection(events, ['earlier', 'link-1'])).toEqual([]);
  });

  it('keeps steering inside the current turn', () => {
    const events = [prompt, permission('a', { ok: true }), steer];
    expect(pendingPermissionRequestsFromProjection(events, ['a'])).toHaveLength(1);
  });

  it('drops an input too large to ride on every summary', () => {
    const big = { body: 'x'.repeat(PERMISSION_INPUT_MAX_BYTES) };
    const [request] = pendingPermissionRequestsFromProjection(
      [prompt, permission('a', big)],
      ['a'],
    );
    expect(request).toEqual({ toolUseId: 'a', tool: 'verity_http_request', riskClass: 'ask' });
    const [small] = pendingPermissionRequestsFromProjection(
      [prompt, permission('a', { body: 'short' })],
      ['a'],
    );
    expect(small?.input).toEqual({ body: 'short' });
  });
});
