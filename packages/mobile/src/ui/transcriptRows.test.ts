import { describe, expect, it } from 'vitest';
import type { Message, ToolCallMessage } from '../happy/message.js';
import { groupRows, rowKey, rowRecycleType } from './transcriptRows.js';

function userText(id: string): Message {
  return { kind: 'user-text', id, localId: null, createdAt: 0, text: id };
}

function toolCall(
  id: string,
  opts: { name?: string; parentToolId?: string } = {},
): ToolCallMessage {
  return {
    kind: 'tool-call',
    id,
    localId: null,
    createdAt: 0,
    tool: {
      name: opts.name ?? 'Bash',
      state: 'completed',
      input: {},
      createdAt: 0,
      startedAt: null,
      completedAt: null,
      description: null,
    },
    children: [],
    ...(opts.parentToolId !== undefined ? { parentToolId: opts.parentToolId } : {}),
  };
}

function planCall(id: string, done: number, opts: { parentToolId?: string } = {}): ToolCallMessage {
  const message = toolCall(id, { name: 'TodoWrite', ...opts });
  message.tool.input = {
    todos: ['One', 'Two', 'Three'].map((content, index) => ({
      content,
      status: index < done ? 'completed' : 'pending',
    })),
  };
  return message;
}

function agentText(id: string, parentToolId?: string): Message {
  return {
    kind: 'agent-text',
    id,
    localId: null,
    createdAt: 0,
    text: id,
    ...(parentToolId !== undefined ? { parentToolId } : {}),
  };
}

describe('groupRows', () => {
  it('returns an empty array for no messages', () => {
    expect(groupRows([])).toEqual([]);
  });

  it('keeps a single tool call its own group (one-element run)', () => {
    const rows = groupRows([toolCall('t1')]);
    expect(rows).toEqual([{ kind: 'tool-group', id: 'tools:t1', tools: [toolCall('t1')] }]);
  });

  it('collapses a maximal run of consecutive tool calls into one group', () => {
    const rows = groupRows([toolCall('t1'), toolCall('t2'), toolCall('t3')]);
    expect(rows).toHaveLength(1);
    // Keyed by the LAST member (t3), not the first: stable when scroll-up prepends
    // older tools onto the run's head (see flushTools in transcriptRows.ts).
    expect(rows[0]).toMatchObject({ kind: 'tool-group', id: 'tools:t3' });
    expect(rows[0] && rows[0].kind === 'tool-group' && rows[0].tools.map((t) => t.id)).toEqual([
      't1',
      't2',
      't3',
    ]);
  });

  it('preserves order and flushes a trailing run after a non-tool message', () => {
    const rows = groupRows([userText('u1'), toolCall('t1'), toolCall('t2')]);
    expect(rows.map((r) => r.kind)).toEqual(['message', 'tool-group']);
    expect(rows[1]).toMatchObject({ id: 'tools:t2' });
  });

  it('separates two tool runs split by a non-tool message into distinct groups', () => {
    const rows = groupRows([toolCall('a1'), userText('u1'), toolCall('b1')]);
    expect(rows.map((r) => r.kind)).toEqual(['tool-group', 'message', 'tool-group']);
    expect(rows[0]).toMatchObject({ id: 'tools:a1' });
    expect(rows[2]).toMatchObject({ id: 'tools:b1' });
  });

  it('nests a sub-agent subtree under one delegated-agent row (not flattened)', () => {
    // Agent dispatch (id `tool-agent1`) + its sub-agent's text + two tool calls,
    // then a top-level tool after the delegation.
    const rows = groupRows([
      toolCall('tool-agent1', { name: 'Agent' }),
      agentText('sa-text', 'agent1'),
      toolCall('tool-read', { name: 'Read', parentToolId: 'agent1' }),
      toolCall('tool-bash', { name: 'Bash', parentToolId: 'agent1' }),
      toolCall('tool-top', { name: 'Bash' }),
    ]);
    // Top level: the delegation card + the trailing top-level tool — the sub-agent's
    // 1 text + 2 tools do NOT appear at top level.
    expect(rows.map((r) => r.kind)).toEqual(['delegated-agent', 'tool-group']);
    const del = rows[0];
    expect(del?.kind).toBe('delegated-agent');
    if (del?.kind === 'delegated-agent') {
      expect(del.parent.id).toBe('tool-agent1');
      expect(del.toolCount).toBe(2); // 2 sub-agent tool calls
      // The subtree, grouped: the sub-agent text, then its two tools collapsed.
      expect(del.childRows.map((r) => r.kind)).toEqual(['message', 'tool-group']);
    }
  });

  it('keeps an orphaned child at top level when its parent is absent (e.g. mid-stream)', () => {
    // The sub-agent's child events can arrive before the parent Agent tool_call
    // (or the parent could be dropped) — the child must still render, not vanish.
    const rows = groupRows([
      toolCall('tool-read', { name: 'Read', parentToolId: 'ghost' }),
      agentText('sa', 'ghost'),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['tool-group', 'message']);
  });

  it('does not infinitely recurse on a malformed cycle (duplicate ids in untrusted input)', () => {
    // Contrived but possible from a buggy/hostile adapter: a duplicate tool id
    // 'tool-a' nested under 'b', whose own children point back to 'a' → would loop
    // forever without the visited guard.
    const rows = groupRows([
      toolCall('tool-a', { name: 'Agent' }), // top-level
      toolCall('tool-b', { name: 'Agent', parentToolId: 'a' }), // child of a
      toolCall('tool-a', { name: 'Read', parentToolId: 'b' }), // dup id 'a', child of b
    ]);
    // Terminates (no stack overflow); the top-level delegation renders.
    expect(rows[0]?.kind).toBe('delegated-agent');
  });

  it('collapses a run of TaskCreate/TaskUpdate into one todo-group', () => {
    const rows = groupRows([
      toolCall('t1', { name: 'TaskCreate' }),
      toolCall('t2', { name: 'TaskUpdate' }),
      toolCall('t3', { name: 'TaskUpdate' }),
      toolCall('b1', { name: 'Bash' }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['todo-group', 'tool-group']);
    const todo = rows[0];
    if (todo?.kind === 'todo-group')
      expect(todo.tools.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
  });
});

describe('rowKey', () => {
  it('uses the group id for a tool-group row', () => {
    expect(rowKey({ kind: 'tool-group', id: 'tools:t1', tools: [toolCall('t1')] })).toBe(
      'tools:t1',
    );
  });

  it('uses the message id for a message row', () => {
    expect(rowKey({ kind: 'message', message: userText('u9') })).toBe('u9');
  });

  it('uses the group id for todo-group and delegated-agent rows', () => {
    expect(rowKey({ kind: 'todo-group', id: 'todos:t1', tools: [toolCall('t1')] })).toBe(
      'todos:t1',
    );
    expect(
      rowKey({
        kind: 'delegated-agent',
        id: 'agent:tool-a1',
        parent: toolCall('tool-a1', { name: 'Agent' }),
        childRows: [],
        toolCount: 0,
      }),
    ).toBe('agent:tool-a1');
  });
});

describe('rowRecycleType', () => {
  it('keeps bounded height pools for differently sized agent prose', () => {
    const row = (length: number) => ({
      kind: 'message' as const,
      message: { ...agentText(`a-${String(length)}`), text: 'x'.repeat(length) },
    });

    expect(rowRecycleType(row(40))).toBe('msg:agent-text:short');
    expect(rowRecycleType(row(500))).toBe('msg:agent-text:medium');
    expect(rowRecycleType(row(1_500))).toBe('msg:agent-text:long');
    expect(rowRecycleType(row(4_000))).toBe('msg:agent-text:xlong');
  });

  it('bounds the top pool so a many-screen turn never shares a short one', () => {
    const row = (length: number) => ({
      kind: 'message' as const,
      message: { ...agentText(`a-${String(length)}`), text: 'x'.repeat(length) },
    });

    // 2.4k and 5.9k stay in `xlong`, but larger turns split into `xxlong` then `huge` so a
    // tall recycled cell is never reused for a ~one-screen row (the blank-block regress).
    expect(rowRecycleType(row(3_000))).toBe('msg:agent-text:xlong');
    expect(rowRecycleType(row(12_000))).toBe('msg:agent-text:xxlong');
    expect(rowRecycleType(row(30_000))).toBe('msg:agent-text:huge');
  });

  it('buckets thinking rows by length and keeps them separate from prose', () => {
    const thinking = (length: number) => {
      const message = agentText(`t-${String(length)}`);
      if (message.kind !== 'agent-text') throw new Error('expected agent text');
      message.isThinking = true;
      message.text = 'x'.repeat(length);
      return { kind: 'message' as const, message };
    };

    expect(rowRecycleType(thinking(40))).toBe('msg:thinking:short');
    expect(rowRecycleType(thinking(4_000))).toBe('msg:thinking:xlong');
  });

  it('buckets operator prompts by length and preserves stable non-prose pools', () => {
    const longPrompt = { ...userText('u1'), text: 'x'.repeat(1_500) };
    expect(rowRecycleType({ kind: 'message', message: userText('u1') })).toBe(
      'msg:user-text:short',
    );
    expect(rowRecycleType({ kind: 'message', message: longPrompt })).toBe('msg:user-text:long');
    expect(rowRecycleType({ kind: 'tool-group', id: 'tools:t1', tools: [toolCall('t1')] })).toBe(
      'tool-group',
    );
  });
});

describe('groupRows reference sharing', () => {
  it('reuses rows and arrays while replacing only an updated text row', () => {
    const prompt = userText('prompt');
    const text = agentText('text');
    const before = groupRows([prompt, text]);
    expect(groupRows([prompt, text], before)).toBe(before);
    const updated = { ...text, text: 'updated' } as Message;
    const after = groupRows([prompt, updated], before);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[1]).toMatchObject({ message: { text: 'updated' } });
  });

  it('updates a tool group on completion and preserves prepend boundary keys', () => {
    const older = toolCall('older');
    const tool = toolCall('tool');
    const prompt = userText('prompt');
    const before = groupRows([tool, prompt]);
    const completed = { ...tool, tool: { ...tool.tool, result: 'output' } };
    const after = groupRows([completed, prompt], before);
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    const prepended = groupRows([older, completed, prompt], after);
    expect(rowKey(prepended[0]!)).toBe(rowKey(after[0]!));
    expect(prepended[0]).toMatchObject({ tools: [older, completed] });
    expect(prepended[1]).toBe(after[1]);
  });

  it('updates delegations for changed children while sharing unaffected subtrees', () => {
    const parent = toolCall('tool-parent', { name: 'Agent' });
    const child = agentText('child', 'parent');
    const other = userText('other');
    const before = groupRows([parent, child, other]);
    expect(groupRows([parent, child, other], before)).toBe(before);
    const updated = { ...child, text: 'new child text' } as Message;
    const after = groupRows([parent, updated, other], before);
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[0]).toMatchObject({ childRows: [{ message: { text: 'new child text' } }] });
  });
});

describe('plan rows', () => {
  it('lifts plans out of tool runs, collapses back-to-back snapshots, and opens only the last', () => {
    const rows = groupRows([
      toolCall('tool-a'),
      planCall('tool-p1', 0),
      planCall('tool-p2', 1),
      toolCall('tool-b'),
      toolCall('tool-c'),
      planCall('tool-p3', 2),
      userText('u1'),
    ]);
    expect(
      rows.map((row) =>
        row.kind === 'plan' ? `plan:${rowKey(row)}:${String(row.latest)}` : row.kind,
      ),
    ).toEqual(['tool-group', 'plan:tool-p2:false', 'tool-group', 'plan:tool-p3:true', 'message']);
    const [latest] = rows.filter((row) => row.kind === 'plan' && row.latest);
    expect(latest?.kind === 'plan' && latest.plan.completed).toBe(2);
    expect(rowRecycleType(rows[1]!)).toBe('plan:closed');
    expect(rowRecycleType(rows[3]!)).toBe('plan:open');
  });

  it('re-renders a plan row that stops being the latest', () => {
    const first = planCall('tool-p1', 0);
    const before = groupRows([first]);
    const after = groupRows([first, toolCall('tool-a'), planCall('tool-p2', 1)], before);
    expect(after[0]).not.toBe(before[0]);
    expect(after[0]).toMatchObject({ kind: 'plan', latest: false });
    // Unchanged, it is reused so the list does not re-render it.
    expect(groupRows([first, toolCall('tool-a'), planCall('tool-p2', 1)], after)[0]).toBe(after[0]);
  });

  it('keeps a sub-agent plan inside its delegation', () => {
    const rows = groupRows([
      toolCall('tool-agent', { name: 'Agent' }),
      planCall('tool-p1', 1, { parentToolId: 'agent' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind === 'delegated-agent' && rows[0].childRows[0]).toMatchObject({
      kind: 'plan',
      latest: true,
    });
  });

  it('leaves a TodoWrite call it cannot read as an ordinary tool', () => {
    expect(groupRows([toolCall('tool-x', { name: 'TodoWrite' })])[0]?.kind).toBe('tool-group');
  });

  it('lifts presented plans out of tool runs and marks only the newest as latest', () => {
    const presented = (id: string, name: string, plan: string): ToolCallMessage => {
      const message = toolCall(id, { name });
      message.tool.input = { plan };
      return message;
    };
    const rows = groupRows([
      toolCall('tool-a'),
      presented('tool-v1', 'mcp__verity__verity_present_plan', '1. First draft'),
      userText('u1'),
      presented('tool-v2', 'verity_present_plan', '1. Revised'),
      toolCall('tool-b'),
    ]);
    // The "Implement plan" decision refers to the newest plan only; an older one
    // keeping its button would implement a plan the operator already revised.
    expect(
      rows.map((row) =>
        row.kind === 'plan-proposal' ? `proposal:${rowKey(row)}:${String(row.latest)}` : row.kind,
      ),
    ).toEqual([
      'tool-group',
      'proposal:tool-v1:false',
      'message',
      'proposal:tool-v2:true',
      'tool-group',
    ]);
    expect(rows[3]).toMatchObject({ markdown: '1. Revised' });
    expect(rowRecycleType(rows[3]!)).toBe('plan-proposal:short');

    // A new planning round starts with no plan to decide on: the last round's plan
    // was already implemented or discarded, so it must not get its button back.
    const nextRound = groupRows([
      presented('tool-v1', 'verity_present_plan', '1. Done already'),
      toolCall('tool-start', { name: 'mcp__verity__verity_start_planning' }),
    ]);
    expect(nextRound[0]).toMatchObject({ kind: 'plan-proposal', latest: false });
  });
});
