import type { AgentEvent } from '@verity/events';
import { describe, expect, it, vi } from 'vitest';
import { buildHandoffPrompt, buildHandoffPromptWithStoredResults } from './handoff.js';

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
  it('retains both ends of the latest instruction and outcome before tool chatter', () => {
    const events = [
      prompt('INSTRUCTION_START ' + 'p'.repeat(1600) + ' INSTRUCTION_END'),
      text('OUTCOME_START ' + 'a'.repeat(1600) + ' OUTCOME_END'),
      toolCall('Check', { command: 'inspect' }),
      toolResult('noise'.repeat(1000)),
    ];
    const out = buildHandoffPrompt(events, 'continue', { tokenBudget: 100 });
    for (const marker of ['INSTRUCTION_START', 'INSTRUCTION_END', 'OUTCOME_START', 'OUTCOME_END']) {
      expect(out).toContain(marker);
    }
    expect(out).toContain('[truncated');
  });

  it('keeps the end of an oversized final answer even without older turns', () => {
    const out = buildHandoffPrompt([text('BEGIN ' + 'x'.repeat(2000) + ' FINAL_STATE')], 'go', {
      tokenBudget: 50,
    });
    expect(out).toContain('BEGIN');
    expect(out).toContain('FINAL_STATE');
    expect(out).toContain('[truncated');
  });

  it('retains tool details beyond the former input and result caps', () => {
    const out = buildHandoffPrompt(
      [
        toolCall('Patch', { patch: 'x'.repeat(500) + ' REQUIRED_CHANGE' }),
        toolResult('x'.repeat(5000) + ' TEST_FAILURE'),
      ],
      'continue',
    );
    expect(out).toContain('REQUIRED_CHANGE');
    expect(out).toContain('TEST_FAILURE');
  });

  it('keeps an interleaved tool result with its own call when older blocks are omitted', () => {
    const out = buildHandoffPrompt(
      [
        { t: 'tool_call', id: 'check-1', name: 'Check', input: 'VERIFY_COMMAND' },
        prompt('x'.repeat(3000)),
        { t: 'tool_result', id: 'check-1', output: 'VERIFICATION_FAILED', isError: true },
      ],
      'go',
      { tokenBudget: 160 },
    );
    expect(out).toContain('VERIFY_COMMAND');
    expect(out).toContain('VERIFICATION_FAILED');
    expect(out).toContain('check-1');
  });

  it('reserves evidence space even when a long assistant outcome follows the exchange', () => {
    const out = buildHandoffPrompt(
      [
        prompt('INSTRUCTION_START ' + 'p'.repeat(2000) + ' INSTRUCTION_END'),
        { t: 'tool_call', id: 'check', name: 'Check', input: 'VERIFY_COMMAND' },
        {
          t: 'tool_result',
          id: 'check',
          output: 'EVIDENCE_START ' + 'x'.repeat(5000) + ' EVIDENCE_END',
          isError: false,
        },
        text('OUTCOME_START ' + 'a'.repeat(2000) + ' OUTCOME_END'),
      ],
      'go',
      { tokenBudget: 200 },
    );
    for (const marker of [
      'INSTRUCTION_START',
      'INSTRUCTION_END',
      'OUTCOME_START',
      'OUTCOME_END',
      'VERIFY_COMMAND',
      'EVIDENCE_START',
      'EVIDENCE_END',
    ]) {
      expect(out).toContain(marker);
    }
  });

  it('marks middle omissions while retaining both ends of large tool inputs and outputs', () => {
    const out = buildHandoffPrompt(
      [
        toolCall(
          'Patch',
          'INPUT_START ' +
            'x'.repeat(4000) +
            ' OMIT_INPUT_MIDDLE ' +
            'x'.repeat(4000) +
            ' INPUT_END',
        ),
        toolResult(
          'RESULT_START ' +
            'y'.repeat(12000) +
            ' OMIT_RESULT_MIDDLE ' +
            'y'.repeat(12000) +
            ' RESULT_END',
        ),
      ],
      'continue',
    );
    for (const marker of ['INPUT_START', 'INPUT_END', 'RESULT_START', 'RESULT_END'])
      expect(out).toContain(marker);
    expect(out).not.toContain('OMIT_INPUT_MIDDLE');
    expect(out).not.toContain('OMIT_RESULT_MIDDLE');
    expect(out).toContain('[truncated');
  });

  it('keeps history separators and retrieval headings within the budget', () => {
    const events = [
      prompt('IMPORTANT ' + 'p'.repeat(3000)),
      text('OUTCOME ' + 'a'.repeat(3000)),
      toolResult('z'.repeat(10000)),
    ];
    const out = buildHandoffPrompt(events, 'continue', { tokenBudget: 300 });
    const history =
      out
        .split('\n\nNow respond')[0]
        ?.split('\n\n')
        .slice(1)
        .filter((block) => !block.startsWith('_(earlier turns omitted'))
        .join('\n\n') ?? '';
    expect(history.length).toBeLessThanOrEqual(300 * 4);
    expect(out.endsWith('continue')).toBe(true);
    expect(buildHandoffPrompt(events, 'continue', { tokenBudget: 0 })).toBe('continue');
  });

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
      text('Latest outcome unrelated to the earlier meeting.'),
    ];

    const out = buildHandoffPrompt(events, 'What did we decide about Datadog?', {
      tokenBudget: 125,
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

describe('stored handoff results', () => {
  const stored = (id: string, bytes = 100): AgentEvent => ({
    t: 'tool_result',
    id,
    output: `PREVIEW_${id}`,
    isError: false,
    outputRef: { id, bytes },
  });
  const blob = (output: unknown) => ({
    mediaType: 'application/json',
    bytes: Buffer.from(JSON.stringify(output)),
  });

  it('loads only selected results and prefers the newest result', async () => {
    const read = vi.fn(async () => blob('FULL_NEW_RESULT'));
    const out = await buildHandoffPromptWithStoredResults(
      [
        stored('old'),
        prompt('old filler ' + 'x'.repeat(3000)),
        prompt('LATEST_INSTRUCTION ' + 'p'.repeat(1000)),
        text('LATEST_OUTCOME ' + 'a'.repeat(1000)),
        stored('new'),
      ],
      'continue',
      read,
      { tokenBudget: 500 },
    );
    expect(read.mock.calls).toHaveLength(1);
    expect(read).toHaveBeenCalledWith('new', expect.any(Number));
    expect(out).toContain('FULL_NEW_RESULT');
    expect(out).not.toContain('PREVIEW_old');
  });

  it('re-budgets expanded results without losing the latest working state', async () => {
    const out = await buildHandoffPromptWithStoredResults(
      [
        prompt('LATEST_INSTRUCTION'),
        text('LATEST_OUTCOME'),
        { t: 'tool_call', id: 'expanded', name: 'Check', input: 'VERIFY_COMMAND' },
        stored('expanded'),
      ],
      'continue',
      async () => blob('EVIDENCE_START ' + 'x'.repeat(20000) + ' EVIDENCE_END'),
      { tokenBudget: 100 },
    );
    expect(out).toContain('LATEST_INSTRUCTION');
    expect(out).toContain('LATEST_OUTCOME');
    expect(out).toContain('VERIFY_COMMAND');
    expect(out).toContain('**Tool result:**');
    expect(out).toContain('EVIDENCE_START');
    expect(out).toContain('EVIDENCE_END');
    const history =
      out
        .split('\n\nNow respond')[0]
        ?.split('\n\n')
        .slice(1)
        .filter((block) => !block.startsWith('_(earlier turns omitted'))
        .join('\n\n') ?? '';
    expect(history.length).toBeLessThanOrEqual(400);
  });

  it.each([
    'missing',
    'invalid-json',
    'invalid-shape',
    'invalid-type',
    'error',
    'too-large',
  ] as const)('marks a %s stored body and keeps the available preview', async (kind) => {
    const out = await buildHandoffPromptWithStoredResults(
      [stored('result')],
      'go',
      async (_id, maxBytes) => {
        if (kind === 'missing') return undefined;
        if (kind === 'error') throw new Error('read failed');
        if (kind === 'invalid-json')
          return { mediaType: 'application/json', bytes: Buffer.from('broken JSON') };
        if (kind === 'invalid-shape') return blob({ unexpected: true });
        if (kind === 'invalid-type') return { ...blob('body'), mediaType: 'image/png' };
        return { mediaType: 'application/json', bytes: Buffer.alloc(maxBytes + 1) };
      },
    );
    expect(out).toContain('PREVIEW_result');
    expect(out).toContain('preview only');
  });

  it('does not fetch a body whose declared size already exceeds the read limit', async () => {
    const read = vi.fn(async () => blob('unused'));
    const out = await buildHandoffPromptWithStoredResults(
      [stored('huge', 100_000_000)],
      'go',
      read,
    );
    expect(read).not.toHaveBeenCalled();
    expect(out).toContain('preview only; handoff read limit');
  });

  it('caps read attempts even for many small selected results', async () => {
    const read = vi.fn(async () => blob('FULL_BODY'));
    const events = Array.from({ length: 30 }, (_, index) => stored(String(index), 10));
    const out = await buildHandoffPromptWithStoredResults(events, 'go', read);
    expect(read).toHaveBeenCalledTimes(16);
    expect(read).toHaveBeenNthCalledWith(1, '29', expect.any(Number));
    expect(out).toContain('PREVIEW_0');
    expect(out).toContain('preview only');
  });

  it('reduces the byte allowance as bodies load instead of fetching all results unbounded', async () => {
    const body = blob('x'.repeat(200000));
    const limits: number[] = [];
    const out = await buildHandoffPromptWithStoredResults(
      Array.from({ length: 6 }, (_, index) => stored(String(index))),
      'go',
      async (_id, maxBytes) => {
        limits.push(maxBytes);
        return body.bytes.length <= maxBytes ? body : undefined;
      },
    );
    expect(limits).toHaveLength(6);
    expect(limits.at(-1)).toBeLessThan(body.bytes.length);
    expect(out).toContain('stored body missing or exceeds read limit');
  });
});
