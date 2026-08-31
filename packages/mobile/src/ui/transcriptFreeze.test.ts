import { describe, expect, it } from 'vitest';
import type { AgentTextMessage, Message, ToolCallMessage } from '../happy/message.js';
import { freezeTranscriptTail, frozenTranscriptRows } from './transcriptFreeze.js';
import { groupRows, rowKey } from './transcriptRows.js';

function userText(id: string): Message {
  return { kind: 'user-text', id, localId: null, createdAt: 0, text: id };
}

function agentText(id: string, text: string): AgentTextMessage {
  return { kind: 'agent-text', id, localId: null, createdAt: 0, text };
}

function toolCall(id: string): ToolCallMessage {
  return {
    kind: 'tool-call',
    id,
    localId: null,
    createdAt: 0,
    tool: {
      name: 'Bash',
      state: 'running',
      input: {},
      createdAt: 0,
      startedAt: null,
      completedAt: null,
      description: null,
    },
    children: [],
  };
}

describe('freezeTranscriptTail', () => {
  it('returns null for an empty transcript', () => {
    expect(freezeTranscriptTail([])).toBeNull();
  });

  it('records the oldest loaded message as the merge boundary', () => {
    const frozen = freezeTranscriptTail([userText('a'), userText('b')]);
    expect(frozen?.boundaryMessageId).toBe('a');
    expect(frozen?.rows.map(rowKey)).toEqual(['a', 'b']);
  });

  it('keeps streamed text at its frozen length', () => {
    const streaming = agentText('text-7', 'half');
    const frozen = freezeTranscriptTail([streaming]);
    streaming.text += ' a much longer continuation';
    const row = frozen?.rows[0];
    expect(row?.kind).toBe('message');
    expect(row?.kind === 'message' && row.message.kind === 'agent-text' && row.message.text).toBe(
      'half',
    );
  });

  it('keeps a running tool call at its frozen state', () => {
    const running = toolCall('tool-1');
    const frozen = freezeTranscriptTail([running]);
    running.tool.state = 'completed';
    running.tool.result = 'a long command output';
    const row = frozen?.rows[0];
    expect(row?.kind === 'tool-group' && row.tools[0]?.tool.state).toBe('running');
    expect(row?.kind === 'tool-group' && row.tools[0]?.tool.result).toBeUndefined();
  });
});

describe('frozenTranscriptRows', () => {
  it('ignores messages that arrived after the freeze', () => {
    const messages: Message[] = [userText('a'), userText('b')];
    const frozen = freezeTranscriptTail(messages);
    if (!frozen) throw new Error('expected a snapshot');
    messages.push(userText('c'));
    expect(frozenTranscriptRows(messages, frozen)?.map(rowKey)).toEqual(['a', 'b']);
  });

  it('returns the snapshot array itself while no older page has arrived', () => {
    const messages: Message[] = [userText('a')];
    const frozen = freezeTranscriptTail(messages);
    if (!frozen) throw new Error('expected a snapshot');
    expect(frozenTranscriptRows(messages, frozen)).toBe(frozen.rows);
  });

  it('merges history loaded after the freeze in front of the snapshot', () => {
    const messages: Message[] = [userText('c'), userText('d')];
    const frozen = freezeTranscriptTail(messages);
    if (!frozen) throw new Error('expected a snapshot');
    messages.unshift(userText('a'), userText('b'));
    // Chronological: the older page first, then the untouched snapshot rows. Reversed
    // for the list, that puts the new rows BEHIND the viewport.
    expect(frozenTranscriptRows(messages, frozen)?.map(rowKey)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('reuses the snapshot rows rather than regrouping them', () => {
    const messages: Message[] = [userText('b')];
    const frozen = freezeTranscriptTail(messages);
    if (!frozen) throw new Error('expected a snapshot');
    messages.unshift(userText('a'));
    const rows = frozenTranscriptRows(messages, frozen);
    expect(rows?.[1]).toBe(frozen.rows[0]);
  });

  it('leaves a delegation straddling the boundary split until the freeze lifts', () => {
    // The sub-agent's output is in the snapshot; its dispatching Agent call only
    // arrives with the older page. Re-nesting it would collapse rows the operator is
    // reading into one card and move everything under them, so the frozen half keeps
    // the child at top level exactly as it was rendered before the page arrived.
    const child = agentText('child', 'sub-agent output');
    child.parentToolId = 'agent1';
    const parent = toolCall('tool-agent1');
    parent.tool.name = 'Agent';
    const messages: Message[] = [child];
    const frozen = freezeTranscriptTail(messages);
    if (!frozen) throw new Error('expected a snapshot');
    messages.unshift(parent);
    expect(frozenTranscriptRows(messages, frozen)?.map(rowKey)).toEqual([
      'tools:tool-agent1',
      'child',
    ]);
    // Lifting the freeze regroups both halves and the nesting returns.
    expect(groupRows(messages).map(rowKey)).toEqual(['agent:tool-agent1']);
  });

  it('reports a lost boundary so the caller can fall back to live rows', () => {
    const frozen = freezeTranscriptTail([userText('a')]);
    if (!frozen) throw new Error('expected a snapshot');
    expect(frozenTranscriptRows([userText('z')], frozen)).toBeNull();
  });
});
