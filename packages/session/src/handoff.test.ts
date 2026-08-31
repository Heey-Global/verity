import type { AgentEvent } from '@verity/events';
import { describe, expect, it } from 'vitest';
import { buildHandoffPrompt } from './handoff.js';

const prompt = (text: string): AgentEvent => ({ t: 'prompt', text });
const text = (delta: string, parentToolId?: string): AgentEvent => ({
  t: 'text',
  delta,
  ...(parentToolId !== undefined ? { parentToolId } : {}),
});
const toolCall = (name: string, input: unknown): AgentEvent => ({
  t: 'tool_call',
  id: `tc-${name}`,
  name,
  input,
});
const toolResult = (output: unknown, isError = false): AgentEvent => ({
  t: 'tool_result',
  id: 'tr',
  output,
  isError,
});

describe('buildHandoffPrompt', () => {
  it('returns the prompt unchanged when there is no prior history', () => {
    expect(buildHandoffPrompt([], 'do the thing')).toBe('do the thing');
    // Non-conversational events only → still nothing to hand off.
    expect(buildHandoffPrompt([{ t: 'status', state: 'running' }], 'go')).toBe('go');
  });

  it('serializes operator/assistant/tool turns and appends the current prompt', () => {
    const events: AgentEvent[] = [
      prompt('read the config'),
      toolCall('Read', { file_path: 'config.ts' }),
      toolResult('export const PORT = 8080;'),
      text('The port is '),
      text('8080.'),
    ];
    const out = buildHandoffPrompt(events, 'now change it to 9090');

    expect(out).toContain('**Operator:**\nread the config');
    expect(out).toContain('**Tool call — Read:**');
    expect(out).toContain('config.ts');
    expect(out).toContain('**Tool result:**\nexport const PORT = 8080;');
    // Streamed text deltas are coalesced into one assistant message.
    expect(out).toContain('**Assistant:**\nThe port is 8080.');
    // The real prompt is appended after the transcript.
    expect(out.endsWith('now change it to 9090')).toBe(true);
    expect(out).toContain('Now respond to');
    // The header frames the transcript as the agent's OWN prior work on a different
    // engine — NOT a separate, still-active agent — so it doesn't mistake its own
    // earlier commits/files for a concurrent agent's edits (the switch-confusion bug).
    expect(out).toContain('your own prior work');
    expect(out).toContain('sole agent');
    expect(out).toContain('no other agent is working here concurrently');
  });

  it('skips sub-agent internals (events with a parentToolId)', () => {
    const events: AgentEvent[] = [
      prompt('delegate something'),
      text('sub-agent chatter', 'tc-Task'),
      { t: 'tool_call', id: 'x', name: 'Grep', input: { pattern: 'foo' }, parentToolId: 'tc-Task' },
    ];
    const out = buildHandoffPrompt(events, 'continue');
    expect(out).not.toContain('sub-agent chatter');
    expect(out).not.toContain('Grep');
    expect(out).toContain('**Operator:**\ndelegate something');
  });

  it('caps a large tool result with a truncation marker', () => {
    const big = 'A'.repeat(5000);
    const out = buildHandoffPrompt([prompt('run it'), toolResult(big)], 'next', {
      toolResultCharCap: 100,
    });
    expect(out).toContain('…[truncated, 5000 chars total]');
    expect(out).not.toContain('A'.repeat(200));
  });

  it('keeps the most recent turns and omits earlier ones when over budget', () => {
    const events: AgentEvent[] = [
      prompt('OLDEST turn marker'),
      prompt('MIDDLE turn'),
      prompt('NEWEST turn marker'),
    ];
    // Small budget: only the newest block fits (each block ~30 chars; budget ~40).
    const out = buildHandoffPrompt(events, 'go', { tokenBudget: 10 });
    expect(out).toContain('NEWEST turn marker');
    expect(out).toContain('earlier turns omitted');
    expect(out).not.toContain('OLDEST turn marker');
  });

  it('retrieves relevant omitted meeting context by terms in the current prompt', () => {
    const events: AgentEvent[] = [
      prompt('In the meeting we decided Datadog export stays out of scope for the MVP.'),
      text('Decision recorded: keep OTEL logs local, no Datadog exporter yet.'),
      prompt('Filler ' + 'x'.repeat(160)),
      prompt('Recent deployment note ' + 'y'.repeat(160)),
      prompt('Newest unrelated note ' + 'z'.repeat(120)),
    ];

    const out = buildHandoffPrompt(events, 'What did we decide about Datadog?', {
      tokenBudget: 75,
    });

    expect(out).toContain('Relevant earlier context');
    expect(out).toContain('no Datadog exporter yet');
    expect(out).toContain('Most recent context');
    expect(out).toContain('Newest unrelated note');
  });

  it('does not spend budget on irrelevant omitted context', () => {
    const events: AgentEvent[] = [
      prompt('Billing migration notes ' + 'x'.repeat(160)),
      prompt('Recent scheduler note ' + 'y'.repeat(160)),
      prompt('Newest deploy note ' + 'z'.repeat(120)),
    ];

    const out = buildHandoffPrompt(events, 'What did we decide about Datadog?', {
      tokenBudget: 55,
    });

    expect(out).toContain('earlier turns omitted');
    expect(out).not.toContain('Relevant earlier context');
    expect(out).not.toContain('Billing migration notes');
    expect(out).toContain('Newest deploy note');
  });

  it('marks a tool result error', () => {
    const out = buildHandoffPrompt([prompt('x'), toolResult('boom', true)], 'y');
    expect(out).toContain('**Tool result (error):**\nboom');
  });

  it('serializes text and image content blocks from tool results', () => {
    const out = buildHandoffPrompt(
      [
        prompt('inspect image'),
        toolResult([{ text: 'OCR text' }, { type: 'image' }, null, { type: 'unknown' }]),
      ],
      'continue',
    );

    expect(out).toContain('OCR text');
    expect(out).toContain('[image]');
  });

  it('serializes object tool results as JSON', () => {
    const out = buildHandoffPrompt(
      [prompt('run command'), toolResult({ exitCode: 0 })],
      'continue',
    );

    expect(out).toContain('{"exitCode":0}');
  });

  it('omits unserializable tool inputs and outputs without crashing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const out = buildHandoffPrompt(
      [prompt('run'), toolCall('Circular', circular), toolResult(circular)],
      'continue',
    );

    expect(out).toContain('**Tool call — Circular:**');
    expect(out).toContain('**Tool result:**');
  });
});
