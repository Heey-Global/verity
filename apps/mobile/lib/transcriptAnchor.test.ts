import type { Message, ToolCallMessage, Row } from '@verity/mobile';
import {
  anchorFromRow,
  anchorMessageId,
  findAnchorIndex,
  messageSeq,
  nextNewerTopLevelSeq,
  rowMatchesAnchor,
  type ScrollAnchor,
} from './transcriptAnchor';

function agentText(seq: number): Message {
  return { kind: 'agent-text', id: `text-${seq}`, localId: null, createdAt: 0, text: `t${seq}` };
}

function userText(seq: number): Message {
  return { kind: 'user-text', id: `text-${seq}`, localId: null, createdAt: 0, text: `u${seq}` };
}

function toolCall(seq: number, parentToolId?: string): ToolCallMessage {
  return {
    kind: 'tool-call',
    id: `tool-${seq}`,
    localId: null,
    createdAt: 0,
    tool: {
      name: 'Bash',
      state: 'completed',
      input: {},
      createdAt: 0,
      startedAt: null,
      completedAt: null,
      description: null,
    },
    children: [],
    ...(parentToolId !== undefined ? { parentToolId } : {}),
  };
}

function messageRow(message: Message): Row {
  return { kind: 'message', message };
}

function toolGroup(...tools: ToolCallMessage[]): Row {
  return { kind: 'tool-group', id: `tools:${tools[tools.length - 1]?.id ?? ''}`, tools };
}

function anchorFor(messageId: string): ScrollAnchor {
  return { rowKey: messageId, messageId, atBottom: false, offsetY: null };
}

/** Oldest → newest, the order history arrives in. The transcript list reverses it. */
const chronological: Row[] = [
  messageRow(userText(10)),
  messageRow(agentText(20)),
  toolGroup(toolCall(30), toolCall(31)),
  messageRow(agentText(40)),
  messageRow(userText(50)),
];
const newestFirst: Row[] = [...chronological].reverse();

describe('messageSeq', () => {
  it('reads the trailing seq of a transcript id', () => {
    expect(messageSeq('text-42')).toBe(42);
    expect(messageSeq('tool-7')).toBe(7);
  });

  it('rejects shapes that would page all of history', () => {
    expect(messageSeq('text-')).toBeNull();
    expect(messageSeq('text-0')).toBeNull();
    expect(messageSeq('text-abc')).toBeNull();
    expect(messageSeq('text-1.5')).toBeNull();
    expect(messageSeq('local')).toBeNull();
  });
});

describe('anchor identity', () => {
  it('names a message row by its message id', () => {
    const anchor = anchorFromRow(messageRow(agentText(20)), false, 12);
    expect(anchor).toEqual({
      rowKey: 'text-20',
      messageId: 'text-20',
      atBottom: false,
      offsetY: 12,
    });
  });

  it('names a tool group by its last member, which is also its key', () => {
    const row = toolGroup(toolCall(30), toolCall(31));
    expect(anchorMessageId(row)).toBe('tool-31');
    expect(rowMatchesAnchor(row, anchorFor('tool-31'))).toBe(true);
  });

  it('still matches a group whose key moved on while the run grew', () => {
    // The row key is `tools:<lastMemberId>` and mutates as the run grows; the saved
    // member id must keep resolving.
    const grown = toolGroup(toolCall(30), toolCall(31), toolCall(32));
    expect(rowMatchesAnchor(grown, anchorFor('tool-30'))).toBe(true);
  });

  it('yields a null anchor for a missing row', () => {
    expect(anchorFromRow(undefined, true, null)).toEqual({
      rowKey: null,
      messageId: null,
      atBottom: true,
      offsetY: null,
    });
  });
});

describe('findAnchorIndex', () => {
  it('finds a row that exists in its own right, in either order', () => {
    expect(findAnchorIndex(chronological, anchorFor('text-20'), 'oldest-first')).toBe(1);
    expect(findAnchorIndex(newestFirst, anchorFor('text-20'), 'newest-first')).toBe(3);
  });

  it('reports a row that is not loaded as missing', () => {
    expect(findAnchorIndex(newestFirst, anchorFor('text-999'), 'newest-first')).toBe(-1);
  });

  it('resolves an empty anchor to no row', () => {
    const empty: ScrollAnchor = { rowKey: null, messageId: null, atBottom: true, offsetY: null };
    expect(findAnchorIndex(newestFirst, empty, 'newest-first')).toBe(-1);
  });
});

describe('coalesced agent text', () => {
  // Streamed agent text is coalesced into one row keyed by its first chunk, so an
  // anchor naming a later chunk (`text-21`..`text-29` here) has no row of its own and
  // must resolve to the row whose seq span covers it.
  it('resolves an absorbed chunk in the newest-first transcript', () => {
    expect(findAnchorIndex(newestFirst, anchorFor('text-25'), 'newest-first')).toBe(3);
  });

  it('resolves the same chunk in a chronological array', () => {
    expect(findAnchorIndex(chronological, anchorFor('text-25'), 'oldest-first')).toBe(1);
  });

  it('does not spill past the next newer row', () => {
    // 45 lies beyond the agent-text row at seq 40 only if the span is read from the
    // wrong side; the next newer row (50) closes it.
    expect(findAnchorIndex(newestFirst, anchorFor('text-45'), 'newest-first')).toBe(1);
    expect(findAnchorIndex(newestFirst, anchorFor('text-55'), 'newest-first')).toBe(-1);
  });

  it('leaves the span open at the newest end', () => {
    const openEnded: Row[] = [messageRow(agentText(40)), messageRow(userText(10))];
    expect(findAnchorIndex(openEnded, anchorFor('text-41'), 'newest-first')).toBe(0);
  });

  it('never resolves an absorbed chunk to a non-agent-text row', () => {
    // Seq 11 sits inside the user row's span, but only streamed agent text coalesces.
    expect(findAnchorIndex(newestFirst, anchorFor('text-11'), 'newest-first')).toBe(-1);
  });

  it('would resolve to the wrong row if the array order were misdeclared', () => {
    // The regression this guards: reading the newest-first list as chronological looks
    // for the span bound in the direction of OLDER rows, whose seq is below the row's
    // own, so the span check never matches and a saved position is discarded.
    expect(findAnchorIndex(newestFirst, anchorFor('text-25'), 'oldest-first')).toBe(-1);
  });
});

describe('nextNewerTopLevelSeq', () => {
  it('walks backward through a newest-first array', () => {
    expect(nextNewerTopLevelSeq(newestFirst, 3, 'newest-first')).toBe(31);
  });

  it('walks forward through a chronological array', () => {
    expect(nextNewerTopLevelSeq(chronological, 1, 'oldest-first')).toBe(31);
  });

  it('returns null at the newest end of either order', () => {
    expect(nextNewerTopLevelSeq(newestFirst, 0, 'newest-first')).toBeNull();
    expect(
      nextNewerTopLevelSeq(chronological, chronological.length - 1, 'oldest-first'),
    ).toBeNull();
  });
});

describe('delegated agents', () => {
  const child = messageRow(agentText(61));
  const delegated: Row = {
    kind: 'delegated-agent',
    id: 'tool-60',
    parent: toolCall(60),
    childRows: [child, messageRow(agentText(62))],
    toolCount: 0,
  };
  const withDelegate: Row[] = [messageRow(userText(70)), delegated, messageRow(userText(50))];

  it('resolves an anchor inside a delegated subtree to the parent row', () => {
    expect(findAnchorIndex(withDelegate, anchorFor('text-61'), 'newest-first')).toBe(1);
  });

  it('resolves a chunk absorbed by a child row, whose children stay chronological', () => {
    expect(findAnchorIndex(withDelegate, anchorFor('text-61'), 'newest-first')).toBe(1);
    expect(
      findAnchorIndex(
        delegated.kind === 'delegated-agent' ? delegated.childRows : [],
        anchorFor('text-62'),
        'oldest-first',
      ),
    ).toBe(1);
  });

  it('matches the delegating tool call itself', () => {
    expect(findAnchorIndex(withDelegate, anchorFor('tool-60'), 'newest-first')).toBe(1);
  });
});
