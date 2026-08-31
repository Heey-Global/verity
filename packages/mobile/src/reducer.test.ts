import type { AgentEvent } from '@verity/events';
import { describe, expect, it } from 'vitest';
import type { AgentTextMessage, ToolCallMessage, UserTextMessage } from './happy/message.js';
import { reduceFrames, SessionReducer } from './reducer.js';

function agentText(messages: readonly { kind: string }[]): AgentTextMessage[] {
  return messages.filter((m): m is AgentTextMessage => m.kind === 'agent-text');
}

function toolCalls(messages: readonly { kind: string }[]): ToolCallMessage[] {
  return messages.filter((m): m is ToolCallMessage => m.kind === 'tool-call');
}

function userText(messages: readonly { kind: string }[]): UserTextMessage[] {
  return messages.filter((m): m is UserTextMessage => m.kind === 'user-text');
}

describe('SessionReducer — sub-agent attribution', () => {
  it('tags sub-agent text/tool events with parentToolId and keeps contexts separate', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'tool_call', id: 'agent1', name: 'Agent', input: { description: 'map it' } });
    r.apply(2, { t: 'text', delta: 'top-level ' });
    r.apply(3, { t: 'text', delta: 'narration', parentToolId: 'agent1' }); // sub-agent → new block
    r.apply(4, {
      t: 'tool_call',
      id: 'read1',
      name: 'Read',
      input: { file_path: '/x' },
      parentToolId: 'agent1',
    });
    const msgs = r.messages;
    // The sub-agent text did NOT merge into the top-level text block.
    const texts = msgs.filter((m) => m.kind === 'agent-text');
    expect(texts.map((m) => (m.kind === 'agent-text' ? m.text : ''))).toEqual([
      'top-level ',
      'narration',
    ]);
    const subText = texts.find((m) => m.kind === 'agent-text' && m.text === 'narration');
    expect(subText?.kind === 'agent-text' && subText.parentToolId).toBe('agent1');
    const read = msgs.find((m) => m.kind === 'tool-call' && m.tool.name === 'Read');
    expect(read?.kind === 'tool-call' && read.parentToolId).toBe('agent1');
    // The top-level Agent dispatch itself is un-parented.
    const agent = msgs.find((m) => m.kind === 'tool-call' && m.tool.name === 'Agent');
    expect(agent?.kind === 'tool-call' && agent.parentToolId).toBeUndefined();
  });
});

describe('SessionReducer', () => {
  it('tracks session id, model and the latest status', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'session', id: 's1', model: 'claude-opus-4-8', worktree: '/wt/s1' });
    r.apply(2, { t: 'status', state: 'running' });
    r.apply(3, { t: 'status', state: 'awaiting_input' });
    expect(r.sessionId).toBe('s1');
    expect(r.model).toBe('claude-opus-4-8');
    expect(r.status).toBe('awaiting_input'); // most recent wins
  });

  it('returns to running when the current awaiting permission is settled', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'status', state: 'awaiting_input' });
    r.apply(2, { t: 'permission', id: 'tool-1', tool: 'Bash', input: {}, riskClass: 'ask' });
    r.resolvePermission('tool-1');
    expect(r.pendingPermission).toBeUndefined();
    expect(r.status).toBe('running');
    expect(r.running).toBe(true);
  });

  it('does not clear unrelated awaiting input when settling a different permission id', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'status', state: 'awaiting_input' });
    r.apply(2, { t: 'permission', id: 'tool-1', tool: 'Bash', input: {}, riskClass: 'ask' });
    r.resolvePermission('other-tool');
    expect(r.pendingPermission?.toolUseId).toBe('tool-1');
    expect(r.status).toBe('awaiting_input');
  });

  it('renders an operator prompt as a user-text message and closes the open agent block', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'text', delta: 'partial agent reply' });
    r.apply(2, { t: 'prompt', text: 'now do the next thing' });
    r.apply(3, { t: 'text', delta: 'fresh reply' });
    // The prompt is a turn boundary: the post-prompt text is a NEW agent block,
    // not accumulated onto the pre-prompt one.
    expect(r.messages.map((m) => m.kind)).toEqual(['agent-text', 'user-text', 'agent-text']);
    expect(r.messages[1]).toMatchObject({ kind: 'user-text', text: 'now do the next thing' });
  });

  it('carries image attachments from a prompt event onto the user-text message', () => {
    const r = new SessionReducer();
    const attachments = [{ kind: 'image' as const, mediaType: 'image/png' as const, data: 'aGk=' }];
    r.apply(1, { t: 'prompt', text: 'see this', attachments });
    expect(r.messages[0]).toMatchObject({ kind: 'user-text', text: 'see this', attachments });
  });

  it('omits attachments on a plain prompt (no empty array)', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'prompt', text: 'plain' });
    expect(r.messages[0]).not.toHaveProperty('attachments');
  });

  it('accumulates consecutive text deltas into a single agent-text message', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'text', delta: 'Hel' });
    r.apply(2, { t: 'text', delta: 'lo, ' });
    r.apply(3, { t: 'text', delta: 'world' });
    const texts = agentText(r.messages);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({
      kind: 'agent-text',
      id: 'text-1',
      createdAt: 1,
      localId: null,
      text: 'Hello, world',
    });
    expect(texts[0]?.isThinking).toBeUndefined();
  });

  it('closes the text block on a non-text event, so later text is a new message', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'text', delta: 'before' });
    // a tool_call (not yet rendered) closes the open block
    r.apply(2, { t: 'tool_call', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } });
    r.apply(3, { t: 'text', delta: 'after' });
    const texts = agentText(r.messages);
    expect(texts.map((m) => m.text)).toEqual(['before', 'after']);
    expect(texts.map((m) => m.id)).toEqual(['text-1', 'text-3']); // distinct blocks
  });

  it('groups thinking deltas by blockId and marks them isThinking', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'thinking', blockId: 'msg_a:0', delta: 'plan ' });
    r.apply(2, { t: 'thinking', blockId: 'msg_a:0', delta: 'step' });
    r.apply(3, { t: 'thinking', blockId: 'msg_a:1', delta: 'next' });
    const texts = agentText(r.messages);
    expect(texts).toHaveLength(2);
    // id keyed by the first delta's seq (collision-free), not the blockId
    expect(texts[0]).toMatchObject({ id: 'think-1', text: 'plan step', isThinking: true });
    expect(texts[1]).toMatchObject({ id: 'think-3', text: 'next', isThinking: true });
  });

  it('a reappearing thinking blockId after a boundary yields distinct ids (no collision)', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'thinking', blockId: 'b', delta: 'one' });
    r.apply(2, { t: 'tool_call', id: 'toolu_1', name: 'Bash', input: {} }); // boundary
    r.apply(3, { t: 'thinking', blockId: 'b', delta: 'two' }); // same blockId reappears
    const ids = agentText(r.messages).map((m) => m.id);
    expect(ids).toEqual(['think-1', 'think-3']); // distinct, no duplicate key
  });

  it('drops an empty thinking block (headless claude exposes no thinking text) (#81)', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'text', delta: 'answer' });
    r.apply(2, { t: 'thinking', blockId: 'msg_a:0', delta: '' });
    r.apply(3, { t: 'thinking', blockId: 'msg_a:1', delta: '   ' }); // whitespace-only too
    // No "Thinking" chip is produced; the empty blocks just acted as boundaries.
    expect(r.messages.map((m) => m.kind)).toEqual(['agent-text']);
    expect(agentText(r.messages).map((m) => m.text)).toEqual(['answer']);
  });

  it('lets a tool run stay contiguous across an empty thinking block (#81)', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'tool_call', id: 'a', name: 'Bash', input: {} });
    r.apply(2, { t: 'tool_result', id: 'a', output: 'ok', isError: false });
    r.apply(3, { t: 'thinking', blockId: 'b', delta: '' }); // dropped → no message
    r.apply(4, { t: 'tool_call', id: 'c', name: 'Read', input: {} });
    // The empty thinking produced no message, so the two tool calls stay adjacent
    // (and `groupRows` then collapses them into one run, tested in transcriptRows).
    expect(r.messages.map((m) => m.kind)).toEqual(['tool-call', 'tool-call']);
  });

  it('still renders a non-empty thinking block as a thinking message', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'thinking', blockId: 'b', delta: 'pondering' });
    expect(agentText(r.messages).map((m) => ({ text: m.text, thinking: m.isThinking }))).toEqual([
      { text: 'pondering', thinking: true },
    ]);
  });

  it('renders later content for a thinking block whose first delta was empty', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'thinking', blockId: 'b', delta: '' }); // empty → dropped, no message
    r.apply(2, { t: 'thinking', blockId: 'b', delta: 'now with content' });
    expect(agentText(r.messages).map((m) => ({ text: m.text, thinking: m.isThinking }))).toEqual([
      { text: 'now with content', thinking: true },
    ]);
  });

  it('a result event mid-stream closes the text block (text → result → text)', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'text', delta: 'one' });
    r.apply(2, {
      t: 'result',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stopReason: 'end_turn',
    });
    r.apply(3, { t: 'text', delta: 'two' });
    const texts = agentText(r.messages);
    expect(texts.map((m) => m.text)).toEqual(['one', 'two']);
    expect(texts.map((m) => m.id)).toEqual(['text-1', 'text-3']);
  });

  it('separates a thinking block from an adjacent text block', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'text', delta: 'answer' });
    r.apply(2, { t: 'thinking', blockId: 'b', delta: 'hmm' });
    r.apply(3, { t: 'text', delta: 'more' });
    const texts = agentText(r.messages);
    expect(texts.map((m) => ({ text: m.text, thinking: m.isThinking ?? false }))).toEqual([
      { text: 'answer', thinking: false },
      { text: 'hmm', thinking: true },
      { text: 'more', thinking: false },
    ]);
  });

  it('renders a tool_call as a running tool-call message with its input', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'tool_call', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } });
    const tools = toolCalls(r.messages);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ kind: 'tool-call', id: 'tool-toolu_1', children: [] });
    expect(tools[0]?.tool).toMatchObject({
      name: 'Bash',
      state: 'running',
      input: { command: 'ls' },
      startedAt: 1,
      completedAt: null,
    });
  });

  it('correlates a tool_result to its tool_call by id (success → completed)', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'tool_call', id: 'toolu_1', name: 'Bash', input: {} });
    r.apply(2, { t: 'tool_result', id: 'toolu_1', output: 'file.txt', isError: false });
    const tools = toolCalls(r.messages);
    expect(tools).toHaveLength(1); // result updates in place, no new message
    expect(tools[0]?.tool).toMatchObject({
      state: 'completed',
      result: 'file.txt',
      completedAt: 2,
    });
  });

  it('marks a tool_result with isError as an errored tool', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'tool_call', id: 'toolu_1', name: 'Write', input: {} });
    r.apply(2, { t: 'tool_result', id: 'toolu_1', output: 'denied', isError: true });
    expect(toolCalls(r.messages)[0]?.tool).toMatchObject({ state: 'error', result: 'denied' });
  });

  it('correlates multiple interleaved tools by id', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'tool_call', id: 'a', name: 'Bash', input: {} });
    r.apply(2, { t: 'tool_call', id: 'b', name: 'Read', input: {} });
    r.apply(3, { t: 'tool_result', id: 'b', output: 'rb', isError: false });
    r.apply(4, { t: 'tool_result', id: 'a', output: 'ra', isError: false });
    const byId = Object.fromEntries(toolCalls(r.messages).map((m) => [m.id, m.tool]));
    expect(byId['tool-a']).toMatchObject({ name: 'Bash', state: 'completed', result: 'ra' });
    expect(byId['tool-b']).toMatchObject({ name: 'Read', state: 'completed', result: 'rb' });
  });

  it('ignores an orphan tool_result with no matching call', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'tool_result', id: 'ghost', output: 'x', isError: false });
    expect(r.messages).toHaveLength(0); // no crash, no phantom message
  });

  it('interleaves tool-call messages with text in stream order', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'text', delta: 'running ' });
    r.apply(2, { t: 'tool_call', id: 'toolu_1', name: 'Bash', input: {} });
    r.apply(3, { t: 'text', delta: 'done' });
    expect(r.messages.map((m) => m.kind)).toEqual(['agent-text', 'tool-call', 'agent-text']);
    expect(agentText(r.messages).map((m) => m.text)).toEqual(['running ', 'done']);
  });

  it('accrues usage and turn count across result events', () => {
    const r = new SessionReducer();
    r.apply(1, {
      t: 'result',
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 3 },
      stopReason: 'end_turn',
    });
    r.apply(2, {
      t: 'result',
      usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 1, cacheCreationTokens: 2 },
      stopReason: 'end_turn',
    });
    expect(r.usage).toEqual({
      inputTokens: 150,
      outputTokens: 30,
      cacheReadTokens: 6,
      cacheCreationTokens: 5,
      turns: 2,
    });
    expect(r.permissionDenials).toEqual([]);
  });

  it('accrues permission denials from result events', () => {
    const r = new SessionReducer();
    r.apply(1, {
      t: 'result',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stopReason: 'end_turn',
      permissionDenials: [{ tool: 'Write' }, { tool: 'Bash' }],
    });
    r.apply(2, {
      t: 'result',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stopReason: 'end_turn',
      permissionDenials: [{ tool: 'WebFetch' }],
    });
    expect(r.permissionDenials).toEqual([
      { tool: 'Write' },
      { tool: 'Bash' },
      { tool: 'WebFetch' },
    ]);
    expect(r.usage.turns).toBe(2);
  });

  it('preserves toolUseId + input on denials through the result fold (#26)', () => {
    const r = new SessionReducer();
    r.apply(1, {
      t: 'result',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stopReason: 'end_turn',
      permissionDenials: [
        { tool: 'Write', toolUseId: 'tu_1', input: { file_path: '/etc/hosts' } },
        { tool: 'Bash' },
      ],
    });
    // The richer denial shape survives the fold into session-level state — the
    // correlation id + attempted input aren't narrowed away.
    expect(r.permissionDenials).toEqual([
      { tool: 'Write', toolUseId: 'tu_1', input: { file_path: '/etc/hosts' } },
      { tool: 'Bash' },
    ]);
  });

  it('exposes usage and denials (zero-initialised) on the session state', () => {
    const fresh = new SessionReducer().state;
    expect(fresh.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      turns: 0,
    });
    expect(fresh.permissionDenials).toEqual([]);
    expect(fresh.rateLimit).toBeUndefined();
  });

  it('renders lifecycle events as agent-event messages, closing the text block', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'text', delta: 'before' });
    r.apply(2, { t: 'compaction', boundary: true });
    r.apply(3, { t: 'error', kind: 'parse_error', message: 'boom' });
    r.apply(4, { t: 'raw', backend: 'claude-code', payload: {} });
    r.apply(5, { t: 'text', delta: 'after' });

    expect(r.messages.map((m) => m.kind)).toEqual([
      'agent-text',
      'agent-event',
      'agent-event',
      'agent-event',
      'agent-text',
    ]);
    const events = r.messages.filter((m) => m.kind === 'agent-event');
    expect(events.map((m) => (m.kind === 'agent-event' ? m.event.t : ''))).toEqual([
      'compaction',
      'error',
      'raw',
    ]);
    expect(events[0]).toMatchObject({ id: 'event-2', createdAt: 2 });
    // the lifecycle events closed the text block → 'before'/'after' stay distinct
    expect(agentText(r.messages).map((m) => m.text)).toEqual(['before', 'after']);
  });

  it('renders a merged marker as an agent-event message without starting a turn', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'text', delta: 'earlier reply' });
    r.apply(2, { t: 'merged', number: 233 });

    // A standalone marker row that closed the open text block, and it did NOT flip
    // the session into `running` (the merge starts no turn).
    expect(r.messages.map((m) => m.kind)).toEqual(['agent-text', 'agent-event']);
    const marker = r.messages[1];
    expect(marker).toMatchObject({
      kind: 'agent-event',
      id: 'event-2',
      event: { t: 'merged', number: 233 },
    });
    expect(r.running).toBe(false);
  });

  it('renders a server notice as a standalone agent text message', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'text', delta: 'streaming reply' });
    r.apply(2, {
      t: 'notice',
      text: 'Meeting transcript saved: [docs/meetings/planning.md](docs/meetings/planning.md)',
    });
    r.apply(3, { t: 'text', delta: 'after notice' });

    expect(r.messages.map((m) => m.kind)).toEqual(['agent-text', 'agent-text', 'agent-text']);
    expect(agentText(r.messages).map((m) => m.text)).toEqual([
      'streaming reply',
      'Meeting transcript saved: [docs/meetings/planning.md](docs/meetings/planning.md)',
      'after notice',
    ]);
    expect(r.running).toBe(false);
  });

  it('renders an operator notice as a standalone user text message without starting a turn', () => {
    const r = new SessionReducer();
    r.apply(1, {
      t: 'notice',
      role: 'operator',
      clientRequestId: 'upload-1',
      text: 'Please transcribe meeting audio: planning.mp3',
    });
    r.apply(2, { t: 'notice', role: 'agent', text: 'Transcribing meeting audio: planning.mp3' });

    expect(r.messages.map((m) => m.kind)).toEqual(['user-text', 'agent-text']);
    expect(userText(r.messages).map((m) => m.text)).toEqual([
      'Please transcribe meeting audio: planning.mp3',
    ]);
    expect(agentText(r.messages).map((m) => m.text)).toEqual([
      'Transcribing meeting audio: planning.mp3',
    ]);
    expect(userText(r.messages)[0]?.localId).toBe('upload-1');
    expect(r.running).toBe(false);
  });

  it('renders a choices event as a choices message, closing the open text block', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'text', delta: 'Here are the options' });
    r.apply(2, {
      t: 'choices',
      question: 'Which?',
      options: [{ label: 'A', recommended: true }, { label: 'B' }],
      multiSelect: true,
    });
    r.apply(3, { t: 'text', delta: 'after' });

    expect(r.messages.map((m) => m.kind)).toEqual(['agent-text', 'choices', 'agent-text']);
    const choices = r.messages[1];
    expect(choices).toMatchObject({
      kind: 'choices',
      id: 'choices-2',
      createdAt: 2,
      question: 'Which?',
      options: [{ label: 'A', recommended: true }, { label: 'B' }],
      multiSelect: true,
    });
    // The choices event is a block boundary → 'after' is a fresh agent-text block.
    expect(agentText(r.messages).map((m) => m.text)).toEqual(['Here are the options', 'after']);
  });

  it('defaults choices.multiSelect to false and omits an absent question', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'choices', options: [{ label: 'Go' }] });
    const choices = r.messages[0];
    expect(choices?.kind).toBe('choices');
    if (choices?.kind === 'choices') {
      expect(choices.multiSelect).toBe(false);
      expect(choices.question).toBeUndefined();
      expect(choices.options).toEqual([{ label: 'Go' }]);
    }
  });

  it('renders an Agent Loop proposal as its own interactive message', () => {
    const r = new SessionReducer();
    r.apply(1, {
      t: 'agent_loop_proposal',
      proposal: {
        loopId: '11111111-1111-4111-8111-111111111111',
        name: 'Dependency audit',
        script: 'exit 0',
        schedule: { kind: 'daily', hour: 3, minute: 0 },
      },
    });
    expect(r.messages[0]).toMatchObject({
      kind: 'agent-loop-proposal',
      id: 'agent-loop-proposal-1',
      proposal: { name: 'Dependency audit' },
    });
  });

  it('tracks the latest rate_limit as state (not a message) and closes the block', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'text', delta: 'before' });
    r.apply(2, { t: 'rate_limit', status: 'allowed', resetsAt: 1, window: 'five_hour' });
    r.apply(3, { t: 'text', delta: 'after' });

    // No transcript row for the rate-limit event — it's session state now.
    expect(r.messages.map((m) => m.kind)).toEqual(['agent-text', 'agent-text']);
    expect(r.state.rateLimit).toEqual({
      status: 'allowed',
      resetsAt: 1,
      window: 'five_hour',
      providerLabel: 'Claude',
    });
    // It still closed the open text block → 'before'/'after' stay distinct.
    expect(agentText(r.messages).map((m) => m.text)).toEqual(['before', 'after']);

    // The latest rate-limit wins (per-turn events overwrite).
    r.apply(4, {
      t: 'rate_limit',
      status: 'rejected',
      resetsAt: 999,
      window: 'five_hour',
      providerLabel: 'Codex',
    });
    expect(r.state.rateLimit).toEqual({
      status: 'rejected',
      resetsAt: 999,
      window: 'five_hour',
      providerLabel: 'Codex',
    });
  });

  it('keeps a rejected provider window when a different window reports allowed', () => {
    const r = new SessionReducer();
    r.apply(1, {
      t: 'rate_limit',
      status: 'rejected',
      resetsAt: 100,
      window: 'five_hour',
      providerLabel: 'Codex',
    });
    r.apply(2, {
      t: 'rate_limit',
      status: 'allowed',
      resetsAt: 200,
      window: 'weekly',
      usedPercent: 76,
      providerLabel: 'Codex',
    });

    expect(r.state.rateLimit).toEqual({
      status: 'rejected',
      resetsAt: 100,
      window: 'five_hour',
      providerLabel: 'Codex',
    });

    r.apply(3, {
      t: 'rate_limit',
      status: 'allowed',
      resetsAt: 300,
      window: 'five_hour',
      providerLabel: 'Codex',
    });
    expect(r.state.rateLimit).toEqual({
      status: 'allowed',
      resetsAt: 300,
      window: 'five_hour',
      providerLabel: 'Codex',
    });
  });

  it('drops expired rejected windows when a fresh capacity event arrives', () => {
    const r = new SessionReducer();
    r.apply(
      1,
      {
        t: 'rate_limit',
        status: 'rejected',
        resetsAt: 100,
        window: 'five_hour',
        providerLabel: 'Codex',
      },
      99_000,
    );
    r.apply(
      2,
      {
        t: 'rate_limit',
        status: 'allowed',
        resetsAt: 200,
        window: 'weekly',
        providerLabel: 'Codex',
      },
      101_000,
    );
    expect(r.state.rateLimit).toMatchObject({ status: 'allowed', window: 'weekly' });
  });

  it('does not let a model-scoped live event replace the provider-wide banner', () => {
    const r = new SessionReducer();
    r.apply(1, {
      t: 'rate_limit',
      status: 'rejected',
      resetsAt: 100,
      window: 'weekly',
      providerLabel: 'Claude',
    });
    r.apply(2, {
      t: 'rate_limit',
      status: 'allowed',
      resetsAt: 200,
      window: 'weekly',
      usedPercent: 0,
      scope: 'sonnet',
      providerLabel: 'Claude',
    });

    expect(r.state.rateLimit).toEqual({
      status: 'rejected',
      resetsAt: 100,
      window: 'weekly',
      providerLabel: 'Claude',
    });
  });

  it('treats a deferred event (permission) as a block boundary with no message', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'text', delta: 'a' });
    r.apply(2, { t: 'permission', id: 'p1', tool: 'Bash', input: {}, riskClass: 'ask' });
    r.apply(3, { t: 'text', delta: 'b' });
    // permission is deferred (Phase-2 UI) → no message, but it still splits text.
    expect(r.messages.map((m) => m.kind)).toEqual(['agent-text', 'agent-text']);
    expect(agentText(r.messages).map((m) => m.text)).toEqual(['a', 'b']);
  });

  it('reduceFrames folds a frame sequence into the full session state', () => {
    const events: { seq: number; event: AgentEvent }[] = [
      { seq: 1, event: { t: 'session', id: 's1', model: 'm', worktree: '/wt/s1' } },
      { seq: 2, event: { t: 'status', state: 'running' } },
      { seq: 3, event: { t: 'text', delta: 'hi ' } },
      { seq: 4, event: { t: 'text', delta: 'there' } },
    ];
    const state = reduceFrames(events.map((e) => ({ k: 'event', seq: e.seq, event: e.event })));
    expect(state).toMatchObject({ sessionId: 's1', model: 'm', status: 'running' });
    expect(agentText(state.messages).map((m) => m.text)).toEqual(['hi there']);
  });

  it('renders an interrupted event as an agent-event row and clears running (#79)', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'prompt', text: 'go' });
    r.apply(2, { t: 'text', delta: 'partial work' });
    expect(r.running).toBe(true); // mid-turn
    r.apply(3, { t: 'interrupted' });

    expect(r.running).toBe(false);
    expect(r.messages.map((m) => m.kind)).toEqual(['user-text', 'agent-text', 'agent-event']);
    const event = r.messages[2];
    expect(event).toMatchObject({ kind: 'agent-event', event: { t: 'interrupted' } });
    // The partial output before the interrupt is preserved.
    expect(agentText(r.messages).map((m) => m.text)).toEqual(['partial work']);
  });

  it('derives running across the turn lifecycle (#79)', () => {
    const r = new SessionReducer();
    expect(r.running).toBe(false); // nothing yet
    r.apply(1, { t: 'session', id: 's1', model: 'm', worktree: '/wt/s1' });
    expect(r.running).toBe(true); // fresh-session bind starts a turn
    r.apply(2, { t: 'text', delta: 'working' });
    expect(r.running).toBe(true);
    r.apply(3, {
      t: 'result',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stopReason: 'end_turn',
    });
    expect(r.running).toBe(false); // turn finished
    r.apply(4, { t: 'prompt', text: 'next' });
    expect(r.running).toBe(true); // a new operator turn started
    r.apply(5, { t: 'interrupted' });
    expect(r.running).toBe(false); // the operator stopped it
  });

  it('stays running when a result lands while a background task is still open', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'prompt', text: 'go' });
    r.apply(2, { t: 'tool_call', id: 'tu1', name: 'Agent', input: {} });
    r.apply(3, { t: 'task', id: 'bg1', phase: 'started', toolUseId: 'tu1' });
    r.apply(4, { t: 'text', delta: 'launched a background agent' });
    // A run_in_background dispatch: the turn's first result fires while the task
    // runs on. The screen must NOT flip to "stopped".
    r.apply(5, {
      t: 'result',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stopReason: 'end_turn',
    });
    expect(r.running).toBe(true); // background work still outstanding
    // The task finishes → the backend re-invokes with a fresh result.
    r.apply(6, { t: 'task', id: 'bg1', phase: 'ended', status: 'completed' });
    expect(r.running).toBe(true); // task closed, but the turn's final result not yet in
    r.apply(7, {
      t: 'result',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stopReason: 'end_turn',
    });
    expect(r.running).toBe(false); // now the turn is truly done
  });

  it('clears running on a terminal status when a background turn ends without a re-invoke', () => {
    // The grace-fallback path: the intra-turn `result`
    // fired with a task open (running stays set), the task then closed, but no
    // post-background `result` arrived — the backend appends a terminal `status`
    // instead. Without honouring it here the working indicator sticks forever.
    const r = new SessionReducer();
    r.apply(1, { t: 'prompt', text: 'go' });
    r.apply(2, { t: 'task', id: 'bg1', phase: 'started', toolUseId: 'tu1' });
    r.apply(3, {
      t: 'result',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stopReason: 'end_turn',
    });
    expect(r.running).toBe(true); // intra-turn result, task still open
    r.apply(4, { t: 'task', id: 'bg1', phase: 'ended', status: 'completed' });
    expect(r.running).toBe(true); // task closed, but no fresh result yet → still stuck
    r.apply(5, { t: 'status', state: 'completed' });
    expect(r.running).toBe(false); // terminal status settles the turn
  });

  it('clears running on a terminal status even if a task ended event was missed', () => {
    // The stuck-indicator fix: a `completed`/`crashed` status is the authoritative
    // turn-end marker — a backend emits it only at true turn end, and the server's
    // `deriveSessionStatus` settles on the status regardless of open tasks.
    // If the reducer MISSED that `task ended` (a dropped / streamed-past frame), its
    // open-task set is stale-non-empty; the old `_openTasks.size === 0` guard then
    // ignored the turn-end status and the working indicator hung forever. Now the
    // terminal status clears running and drains the set unconditionally.
    const r = new SessionReducer();
    r.apply(1, { t: 'prompt', text: 'go' });
    r.apply(2, { t: 'task', id: 'bg1', phase: 'started', toolUseId: 'tu1' });
    // (its `task ended` never reaches the reducer)
    r.apply(3, { t: 'status', state: 'completed' });
    expect(r.running).toBe(false); // authoritative turn-end settles it despite the stale task
  });

  it('keeps running through a mid-turn error (adapter diagnostic, not terminal)', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'prompt', text: 'go' });
    r.apply(2, { t: 'text', delta: 'working' });
    // A canonical `error` is the adapter's per-line/per-block diagnostic — the
    // turn is still live and interruptible, so running must stay true.
    r.apply(3, { t: 'error', kind: 'parse_error', message: 'one bad line' });
    expect(r.running).toBe(true);
    r.apply(4, { t: 'text', delta: 'more work' });
    expect(r.running).toBe(true);
    r.apply(5, {
      t: 'result',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stopReason: 'end_turn',
    });
    expect(r.running).toBe(false); // only the result ends it
  });

  it('hides stale Claude resume probe errors from the transcript', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'prompt', text: 'go' });
    r.apply(2, {
      t: 'error',
      kind: 'claude_result_error',
      message: 'No conversation found with session ID: old-claude-thread',
    });

    expect(r.running).toBe(true);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({ kind: 'user-text', text: 'go' });
  });

  it('a finished session replays to running=false (last turn ended in a result)', () => {
    const events: AgentEvent[] = [
      { t: 'prompt', text: 'go' },
      { t: 'session', id: 's1', model: 'm', worktree: '/wt/s1' },
      { t: 'text', delta: 'done' },
      {
        t: 'result',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
        stopReason: 'end_turn',
      },
    ];
    const state = reduceFrames(
      events.map((event, i) => ({ k: 'event' as const, seq: i + 1, event })),
    );
    expect(state.running).toBe(false);
  });
});

describe('SessionReducer — per-event timestamp (#32)', () => {
  it('uses the frame ts for a message createdAt, not the seq proxy', () => {
    const r = new SessionReducer();
    const ts = 1_700_000_000_000;
    r.apply(2, { t: 'text', delta: 'hello' }, ts);
    const text = r.messages.find((m) => m.kind === 'agent-text');
    // createdAt is the real persist time (ts), NOT the seq (2).
    expect(text?.createdAt).toBe(ts);
  });

  it('falls back to seq for createdAt when ts is absent (older server frame)', () => {
    const r = new SessionReducer();
    r.apply(7, { t: 'text', delta: 'hi' }); // no ts arg
    const text = r.messages.find((m) => m.kind === 'agent-text');
    expect(text?.createdAt).toBe(7);
  });

  it('threads ts into a tool call createdAt/startedAt/completedAt', () => {
    const r = new SessionReducer();
    const t0 = 1_700_000_000_000;
    const t1 = 1_700_000_005_000;
    r.apply(1, { t: 'tool_call', id: 't1', name: 'Bash', input: { command: 'ls' } }, t0);
    r.apply(2, { t: 'tool_result', id: 't1', output: 'ok', isError: false }, t1);
    const tool = r.messages.find((m) => m.kind === 'tool-call');
    expect(tool?.kind === 'tool-call' && tool.tool.createdAt).toBe(t0);
    expect(tool?.kind === 'tool-call' && tool.tool.startedAt).toBe(t0);
    expect(tool?.kind === 'tool-call' && tool.tool.completedAt).toBe(t1);
  });

  it('applyFrame routes the frame ts into createdAt, and falls back to seq when omitted', () => {
    const ts = 1_700_000_000_000;
    const withTs = new SessionReducer();
    withTs.applyFrame({ k: 'event', seq: 3, ts, event: { t: 'text', delta: 'a' } });
    expect(withTs.messages.find((m) => m.kind === 'agent-text')?.createdAt).toBe(ts);

    const withoutTs = new SessionReducer();
    withoutTs.applyFrame({ k: 'event', seq: 5, event: { t: 'text', delta: 'b' } });
    expect(withoutTs.messages.find((m) => m.kind === 'agent-text')?.createdAt).toBe(5);
  });
});

describe('SessionReducer — live per-tool permission (#149)', () => {
  const ZERO_USAGE = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  } as const;

  it('surfaces a `permission` event as pendingPermission (tool/input/id/riskClass/ts)', () => {
    const r = new SessionReducer();
    const ts = 1_700_000_000_000;
    r.apply(
      1,
      {
        t: 'permission',
        id: 'tu_1',
        tool: 'Bash',
        input: { command: 'rm -rf build' },
        riskClass: 'ask',
      },
      ts,
    );
    expect(r.pendingPermission).toEqual({
      toolUseId: 'tu_1',
      tool: 'Bash',
      input: { command: 'rm -rf build' },
      riskClass: 'ask',
      createdAt: ts,
    });
    // It's NOT rendered as a transcript row (it's a live prompt, not a message).
    expect(r.messages).toHaveLength(0);
    // And it's exposed on the state snapshot.
    expect(r.state.pendingPermission?.toolUseId).toBe('tu_1');
  });

  it('carries the prompt channel through to the card, and omits it when absent', () => {
    // The card offers different standing scopes per channel (ADR 0014 D3), so the
    // value has to survive the reducer rather than be re-derived on the client —
    // nothing the app can see says which transport a prompt arrived on.
    const r = new SessionReducer();
    r.apply(1, {
      t: 'permission',
      id: 'tu_acp',
      tool: 'verity_http_request',
      input: {},
      riskClass: 'ask',
      grantChannel: 'acp',
    });
    expect(r.pendingPermission?.grantChannel).toBe('acp');
    // A prompt from a server that predates the field carries none, and must not be
    // given one here: the card's own default decides what an unknown channel means.
    r.apply(2, {
      t: 'permission',
      id: 'tu_old',
      tool: 'verity_http_request',
      input: {},
      riskClass: 'ask',
    });
    expect(r.pendingPermission).not.toHaveProperty('grantChannel');
  });

  it('clears the prompt when the approved tool runs (matching tool_call)', () => {
    const r = new SessionReducer();
    r.apply(1, {
      t: 'permission',
      id: 'tu_1',
      tool: 'Bash',
      input: { command: 'ls' },
      riskClass: 'ask',
    });
    expect(r.pendingPermission?.toolUseId).toBe('tu_1');
    r.apply(2, { t: 'tool_call', id: 'tu_1', name: 'Bash', input: { command: 'ls' } });
    expect(r.pendingPermission).toBeUndefined();
  });

  it('clears the prompt when a matching tool_result arrives (deny short-circuit / run)', () => {
    const r = new SessionReducer();
    r.apply(1, {
      t: 'permission',
      id: 'tu_1',
      tool: 'Write',
      input: { file_path: '/x' },
      riskClass: 'ask',
    });
    r.apply(2, { t: 'tool_result', id: 'tu_1', output: 'denied', isError: true });
    expect(r.pendingPermission).toBeUndefined();
  });

  it('keeps the prompt when an UNRELATED tool runs (different id)', () => {
    const r = new SessionReducer();
    r.apply(1, {
      t: 'permission',
      id: 'tu_1',
      tool: 'Bash',
      input: { command: 'ls' },
      riskClass: 'ask',
    });
    r.apply(2, { t: 'tool_call', id: 'other', name: 'Read', input: { file_path: '/y' } });
    expect(r.pendingPermission?.toolUseId).toBe('tu_1');
  });

  it('clears the prompt when a fresh session binds (the start of a new turn)', () => {
    const r = new SessionReducer();
    r.apply(1, {
      t: 'permission',
      id: 'tu_1',
      tool: 'Bash',
      input: { command: 'ls' },
      riskClass: 'ask',
    });
    r.apply(2, { t: 'session', id: 's1', model: 'claude-opus-4-8', worktree: '/wt/s1' });
    expect(r.pendingPermission).toBeUndefined();
    expect(r.running).toBe(true);
  });

  it('clears the prompt when the turn ends (result)', () => {
    const r = new SessionReducer();
    r.apply(1, {
      t: 'permission',
      id: 'tu_1',
      tool: 'Bash',
      input: { command: 'ls' },
      riskClass: 'ask',
    });
    r.apply(2, { t: 'result', usage: ZERO_USAGE, stopReason: 'end_turn' });
    expect(r.pendingPermission).toBeUndefined();
  });

  it('clears the prompt when the operator interrupts the turn', () => {
    const r = new SessionReducer();
    r.apply(1, {
      t: 'permission',
      id: 'tu_1',
      tool: 'Bash',
      input: { command: 'ls' },
      riskClass: 'ask',
    });
    r.apply(2, { t: 'interrupted' });
    expect(r.pendingPermission).toBeUndefined();
  });

  it('clears the prompt when a new turn starts (prompt)', () => {
    const r = new SessionReducer();
    r.apply(1, {
      t: 'permission',
      id: 'tu_1',
      tool: 'Bash',
      input: { command: 'ls' },
      riskClass: 'ask',
    });
    r.apply(2, { t: 'prompt', text: 'do something else' });
    expect(r.pendingPermission).toBeUndefined();
  });

  it('replaces the prompt when a second permission arrives (latest wins)', () => {
    const r = new SessionReducer();
    r.apply(1, {
      t: 'permission',
      id: 'tu_1',
      tool: 'Bash',
      input: { command: 'ls' },
      riskClass: 'ask',
    });
    r.apply(2, {
      t: 'permission',
      id: 'tu_2',
      tool: 'Write',
      input: { file_path: '/z' },
      riskClass: 'ask',
    });
    expect(r.pendingPermission?.toolUseId).toBe('tu_2');
    expect(r.pendingPermission?.tool).toBe('Write');
  });
});

describe('SessionReducer — skill body correlation', () => {
  const skillOf = (msgs: readonly { kind: string }[]): ToolCallMessage | undefined =>
    toolCalls(msgs).find((m) => m.tool.name === 'Skill');

  it('folds a skill body into the preceding Skill card as collapsed detail', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'tool_call', id: 'sk1', name: 'Skill', input: { skill: 'code-review' } });
    r.apply(2, {
      t: 'tool_result',
      id: 'sk1',
      output: 'Launching skill: code-review',
      isError: false,
    });
    r.apply(3, { t: 'skill', text: 'You are reviewing for recall…\nPhase 0 — Gather the diff' });
    const skill = skillOf(r.messages);
    expect(skill?.tool.skillBody).toBe('You are reviewing for recall…\nPhase 0 — Gather the diff');
    // The body is NOT rendered as its own agent-text bubble (no leak).
    expect(agentText(r.messages)).toHaveLength(0);
  });

  it('drops a skill event with no preceding Skill call (non-skill synthetic turn)', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'text', delta: 'working…' });
    r.apply(2, { t: 'skill', text: 'Continue from where you left off.' });
    // Nothing rendered for the stray synthetic turn; no crash.
    expect(agentText(r.messages).map((m) => m.text)).toEqual(['working…']);
    expect(toolCalls(r.messages)).toHaveLength(0);
  });

  it('does not attach a skill body to a NON-skill tool call', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'tool_call', id: 'b1', name: 'Bash', input: { command: 'ls' } });
    r.apply(2, { t: 'skill', text: 'stray synthetic body' });
    const bash = toolCalls(r.messages).find((m) => m.tool.name === 'Bash');
    expect(bash?.tool.skillBody).toBeUndefined();
  });

  it('abandons a pending skill body once agent prose intervenes', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'tool_call', id: 'sk1', name: 'Skill', input: { skill: 'code-review' } });
    r.apply(2, {
      t: 'tool_result',
      id: 'sk1',
      output: 'Launching skill: code-review',
      isError: false,
    });
    r.apply(3, { t: 'text', delta: 'On it.' }); // prose → the body window closes
    r.apply(4, { t: 'skill', text: 'a much later stray synthetic turn' });
    expect(skillOf(r.messages)?.tool.skillBody).toBeUndefined();
  });

  it('abandons a pending skill body when an unrelated tool result intervenes', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'tool_call', id: 'sk1', name: 'Skill', input: { skill: 'code-review' } });
    r.apply(2, { t: 'tool_result', id: 'other', output: 'done', isError: false });
    r.apply(3, { t: 'skill', text: 'must not attach' });
    expect(skillOf(r.messages)?.tool.skillBody).toBeUndefined();
  });

  it('drops a pending body when a mid-turn boundary (permission) intervenes', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'tool_call', id: 'sk1', name: 'Skill', input: { skill: 'code-review' } });
    r.apply(2, { t: 'tool_result', id: 'sk1', output: 'Launching…', isError: false });
    // A permission prompt for the next tool lands before any body — the window closes.
    r.apply(3, {
      t: 'permission',
      id: 'p1',
      tool: 'Bash',
      input: { command: 'rm' },
      riskClass: 'ask',
    });
    r.apply(4, { t: 'skill', text: 'a stray synthetic turn, not this skill’s body' });
    expect(skillOf(r.messages)?.tool.skillBody).toBeUndefined();
  });

  it('ignores an empty/whitespace body (card stays non-expandable)', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'tool_call', id: 'sk1', name: 'Skill', input: { skill: 'code-review' } });
    r.apply(2, { t: 'tool_result', id: 'sk1', output: 'Launching…', isError: false });
    r.apply(3, { t: 'skill', text: '   \n  ' });
    expect(skillOf(r.messages)?.tool.skillBody).toBeUndefined();
  });

  it('keeps the Skill card running past its ack, then settles it at turn end', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'tool_call', id: 'sk1', name: 'Skill', input: { skill: 'code-review' } });
    // The ack lands immediately but the review runs on — the card must stay running
    // (pulsing) rather than flip to completed the instant the skill launches.
    r.apply(2, {
      t: 'tool_result',
      id: 'sk1',
      output: 'Launching skill: code-review',
      isError: false,
    });
    expect(skillOf(r.messages)?.tool.state).toBe('running');
    r.apply(3, { t: 'tool_call', id: 'a1', name: 'Agent', input: { description: 'review' } });
    r.apply(4, { t: 'tool_result', id: 'a1', output: 'done', isError: false });
    expect(skillOf(r.messages)?.tool.state).toBe('running'); // still pulsing mid-review
    r.apply(5, {
      t: 'result',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stopReason: 'end_turn',
    });
    expect(skillOf(r.messages)?.tool.state).toBe('completed'); // turn ended → settled
  });

  it('settles a running Skill card when the turn is interrupted', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'tool_call', id: 'sk1', name: 'Skill', input: { skill: 'code-review' } });
    r.apply(2, { t: 'tool_result', id: 'sk1', output: 'Launching…', isError: false });
    r.apply(3, { t: 'interrupted' });
    expect(skillOf(r.messages)?.tool.state).toBe('completed');
  });

  it('marks a Skill card errored when its ack is an error (no running hold)', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'tool_call', id: 'sk1', name: 'Skill', input: { skill: 'code-review' } });
    r.apply(2, { t: 'tool_result', id: 'sk1', output: 'no such skill', isError: true });
    expect(skillOf(r.messages)?.tool.state).toBe('error');
  });
});
