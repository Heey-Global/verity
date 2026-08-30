import { describe, expect, it } from 'vitest';
import {
  agentEventSchema,
  attachmentUploadSchema,
  isAgentEvent,
  parseAgentEvent,
  type AgentEvent,
} from './events.js';

/** One valid example per canonical variant — kept exhaustive on purpose. */
const validEvents: Record<AgentEvent['t'], AgentEvent> = {
  session: { t: 'session', id: 's1', model: 'claude-sonnet-4-6', worktree: '/w/agent-s1' },
  status: { t: 'status', state: 'running' },
  text: { t: 'text', delta: 'hello' },
  notice: { t: 'notice', text: 'Meeting transcript saved', role: 'agent' },
  prompt: { t: 'prompt', text: 'do the thing' },
  thinking: { t: 'thinking', blockId: 'b1', signature: 'sig', delta: 'pondering' },
  skill: { t: 'skill', text: '# /code-review\nRun before push.' },
  tool_call_start: { t: 'tool_call_start', id: 't1', name: 'Bash' },
  tool_call: { t: 'tool_call', id: 't1', name: 'Bash', input: { command: 'ls' } },
  tool_result: { t: 'tool_result', id: 't1', output: 'a\nb', isError: false },
  permission: {
    t: 'permission',
    id: 'p1',
    tool: 'Bash',
    input: { command: 'rm' },
    riskClass: 'ask',
  },
  result: {
    t: 'result',
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 0 },
    stopReason: 'end_turn',
    telemetry: {
      backend: 'claude',
      mode: 'live-stdin',
      userPromptChars: 12,
      runtimePromptChars: 0,
      submittedPromptChars: 12,
      attachments: 0,
      resumed: false,
    },
  },
  rate_limit: {
    t: 'rate_limit',
    status: 'allowed',
    resetsAt: 1_700_000_000,
    window: 'weekly',
    usedPercent: 76,
  },
  task: {
    t: 'task',
    id: 'task-1',
    phase: 'started',
    toolUseId: 'toolu_1',
    description: 'Run echo subagent test',
    status: 'completed',
  },
  choices: {
    t: 'choices',
    question: 'Which one?',
    options: [{ label: 'Build it now', recommended: true }, { label: 'Formalize first' }],
    multiSelect: false,
  },
  agent_loop_proposal: {
    t: 'agent_loop_proposal',
    proposal: {
      loopId: '11111111-1111-4111-8111-111111111111',
      name: 'Dependency audit',
      script: '#!/bin/sh\nexit 0',
      schedule: { kind: 'daily', hour: 3, minute: 0 },
    },
  },
  interrupted: { t: 'interrupted' },
  merged: { t: 'merged', number: 233 },
  compaction: { t: 'compaction', boundary: true },
  error: { t: 'error', kind: 'spawn_failed', message: 'boom' },
  raw: { t: 'raw', backend: 'claude-code', payload: { queue: 'op' } },
};

describe('agentEventSchema', () => {
  it.each(Object.entries(validEvents))('accepts a valid %s event', (_t, event) => {
    const result = agentEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  it('routes the discriminated union to the matching variant', () => {
    const parsed = agentEventSchema.parse(validEvents.tool_result);
    expect(parsed.t).toBe('tool_result');
    if (parsed.t === 'tool_result') {
      expect(parsed.isError).toBe(false);
    }
  });

  it('rejects an unknown discriminant', () => {
    expect(agentEventSchema.safeParse({ t: 'nope' }).success).toBe(false);
  });

  it('rejects a known variant with a missing required field', () => {
    expect(agentEventSchema.safeParse({ t: 'session', id: 's1', model: 'm' }).success).toBe(false);
  });

  it('rejects a wrong field type', () => {
    expect(
      agentEventSchema.safeParse({ t: 'tool_result', id: 't1', output: 'x', isError: 'no' })
        .success,
    ).toBe(false);
  });

  it('requires an unknown-typed payload key to be present (zod-4 semantics)', () => {
    // In zod 4 a `z.unknown()` field does NOT make the key optional. The
    // adapter relies on this: a `tool_call` without its `input` is a partial
    // event (input is only valid JSON at block_stop) and must be rejected.
    expect(agentEventSchema.safeParse({ t: 'tool_call', id: 't1', name: 'Bash' }).success).toBe(
      false,
    );
    expect(
      agentEventSchema.safeParse({ t: 'tool_call', id: 't1', name: 'Bash', input: undefined })
        .success,
    ).toBe(true);
  });

  it('requires compaction.boundary to be literally true', () => {
    expect(agentEventSchema.safeParse({ t: 'compaction', boundary: false }).success).toBe(false);
  });

  it('rejects choices with more than one recommended option', () => {
    expect(
      agentEventSchema.safeParse({
        t: 'choices',
        options: [
          { label: 'A', recommended: true },
          { label: 'B', recommended: true },
        ],
      }).success,
    ).toBe(false);
  });

  it('bounds choice text and option count', () => {
    expect(
      agentEventSchema.safeParse({ t: 'choices', options: [{ label: 'x'.repeat(201) }] }).success,
    ).toBe(false);
    expect(
      agentEventSchema.safeParse({
        t: 'choices',
        question: 'q'.repeat(1001),
        options: [{ label: 'ok' }],
      }).success,
    ).toBe(false);
    expect(
      agentEventSchema.safeParse({
        t: 'choices',
        options: Array.from({ length: 21 }, (_, i) => ({ label: String(i) })),
      }).success,
    ).toBe(false);
  });

  it('rejects negative or fractional token counts in usage', () => {
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheCreationTokens: 1 };
    expect(
      agentEventSchema.safeParse({
        t: 'result',
        usage: { ...usage, inputTokens: -1 },
        stopReason: 'x',
      }).success,
    ).toBe(false);
    expect(
      agentEventSchema.safeParse({
        t: 'result',
        usage: { ...usage, outputTokens: 1.5 },
        stopReason: 'x',
      }).success,
    ).toBe(false);
  });

  it('treats thinking.signature as optional', () => {
    const result = agentEventSchema.safeParse({ t: 'thinking', blockId: 'b1', delta: 'x' });
    expect(result.success).toBe(true);
  });

  it('reads a retired grantChannel as absent instead of failing the event', () => {
    const result = parseAgentEvent({ ...validEvents.permission, grantChannel: 'native' });
    expect(result.success).toBe(true);
    expect(result.success && result.data.t === 'permission' && result.data.grantChannel).toBe(
      undefined,
    );
  });

  // The transform leaves the key in place holding `undefined` rather than deleting it, so a
  // consumer reading the field and one re-serializing the event agree: `?? `, `=== 'acp'` and
  // a JSON round-trip all see a channel that is not there.
  it('drops a retired grantChannel out of the re-serialized event', () => {
    const result = parseAgentEvent({ ...validEvents.permission, grantChannel: 'native' });
    const event = result.success ? result.data : undefined;
    expect(JSON.parse(JSON.stringify(event))).not.toHaveProperty('grantChannel');
  });

  it('keeps reading the grantChannel that survived', () => {
    const result = parseAgentEvent({ ...validEvents.permission, grantChannel: 'acp' });
    expect(result.success && result.data.t === 'permission' && result.data.grantChannel).toBe(
      'acp',
    );
  });

  it('still rejects a grantChannel that was never a channel', () => {
    expect(parseAgentEvent({ ...validEvents.permission, grantChannel: 'attested' }).success).toBe(
      false,
    );
  });

  it('accepts a result with permissionDenials and rejects a blank tool name', () => {
    expect(
      agentEventSchema.safeParse({
        ...validEvents.result,
        permissionDenials: [{ tool: 'Write' }, { tool: 'Bash' }],
      }).success,
    ).toBe(true);
    expect(
      agentEventSchema.safeParse({ ...validEvents.result, permissionDenials: [{ tool: '' }] })
        .success,
    ).toBe(false);
  });

  it('accepts a denial carrying toolUseId + input for correlation (#26)', () => {
    const result = agentEventSchema.safeParse({
      ...validEvents.result,
      permissionDenials: [{ tool: 'Write', toolUseId: 'tu_1', input: { file_path: '/etc/hosts' } }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a bare denial with toolUseId + input omitted (additive/optional)', () => {
    const result = agentEventSchema.safeParse({
      ...validEvents.result,
      permissionDenials: [{ tool: 'Write' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a denial with a blank toolUseId (min(1) when present)', () => {
    const result = agentEventSchema.safeParse({
      ...validEvents.result,
      permissionDenials: [{ tool: 'Write', toolUseId: '' }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a prompt whose attachments are content-addressed refs (id)', () => {
    const result = agentEventSchema.safeParse({
      t: 'prompt',
      text: 'look at this',
      attachments: [{ kind: 'image', mediaType: 'image/png', id: 'abc123' }],
    });
    expect(result.success).toBe(true);
  });

  it('still accepts a legacy inline-data attachment (backward compat)', () => {
    expect(
      agentEventSchema.safeParse({
        t: 'prompt',
        text: '',
        attachments: [{ kind: 'image', mediaType: 'image/jpeg', data: 'eA==' }],
      }).success,
    ).toBe(true);
  });

  it('rejects an attachment with neither id nor data', () => {
    expect(
      agentEventSchema.safeParse({
        t: 'prompt',
        text: 'x',
        attachments: [{ kind: 'image', mediaType: 'image/png' }],
      }).success,
    ).toBe(false);
  });

  it('rejects an attachment with an unsupported media type or non-image kind', () => {
    expect(
      agentEventSchema.safeParse({
        t: 'prompt',
        text: 'x',
        attachments: [{ kind: 'image', mediaType: 'image/tiff', id: 'a' }],
      }).success,
    ).toBe(false);
    expect(
      agentEventSchema.safeParse({
        t: 'prompt',
        text: 'x',
        attachments: [{ kind: 'file', mediaType: 'image/png', id: 'a' }],
      }).success,
    ).toBe(false);
  });

  it('attachmentUploadSchema requires base64 data and a supported media type', () => {
    expect(
      attachmentUploadSchema.safeParse({ kind: 'image', mediaType: 'image/png', data: 'aGk=' })
        .success,
    ).toBe(true);
    expect(
      attachmentUploadSchema.safeParse({ kind: 'image', mediaType: 'image/png', data: '' }).success,
    ).toBe(false);
    expect(
      attachmentUploadSchema.safeParse({ kind: 'image', mediaType: 'image/tiff', data: 'aGk=' })
        .success,
    ).toBe(false);
  });
});

describe('parseAgentEvent', () => {
  it('returns a typed event on success', () => {
    const result = parseAgentEvent(validEvents.status);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.t).toBe('status');
    }
  });

  it('returns issues on failure instead of throwing', () => {
    const result = parseAgentEvent({ t: 'text' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });
});

describe('isAgentEvent', () => {
  it('narrows a valid event', () => {
    const value: unknown = validEvents.session;
    expect(isAgentEvent(value)).toBe(true);
  });

  it('rejects a non-event', () => {
    expect(isAgentEvent({ hello: 'world' })).toBe(false);
    expect(isAgentEvent(null)).toBe(false);
    expect(isAgentEvent('text')).toBe(false);
  });
});
