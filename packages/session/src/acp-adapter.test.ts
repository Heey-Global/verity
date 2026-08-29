import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { AcpEventAdapter, AcpTextStream, finalAcpTextEvents } from './acp-adapter.js';

describe('AcpEventAdapter', () => {
  it('maps text and nested thinking attribution', () => {
    const adapter = new AcpEventAdapter();
    expect(
      adapter.consume({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      }),
    ).toEqual([{ t: 'text', delta: 'hello', parentToolId: undefined }]);
    expect(
      adapter.consume({
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'thought-1',
        content: { type: 'text', text: 'reasoning' },
        _meta: { claudeCode: { parentToolUseId: 'task-1' } },
      }),
    ).toEqual([
      {
        t: 'thinking',
        blockId: 'thought-1',
        delta: 'reasoning',
        parentToolId: 'task-1',
      },
    ]);
  });

  it('does not expose recognized ACP bookkeeping as transcript events', () => {
    const adapter = new AcpEventAdapter();
    const updates: SessionUpdate[] = [
      { sessionUpdate: 'plan', entries: [] },
      {
        sessionUpdate: 'plan_update',
        plan: { type: 'items', planId: 'plan-1', entries: [] },
      },
      { sessionUpdate: 'plan_removed', planId: 'plan-1' },
      { sessionUpdate: 'available_commands_update', availableCommands: [] },
      { sessionUpdate: 'current_mode_update', currentModeId: 'default' },
      { sessionUpdate: 'config_option_update', configOptions: [] },
      { sessionUpdate: 'session_info_update', title: 'Smoke test' },
      { sessionUpdate: 'usage_update', used: 1, size: 100 },
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'echo' } },
    ];

    expect(updates.flatMap((update) => adapter.consume(update))).toEqual([]);
  });

  it('maps vendor-neutral Claude lifecycle metadata without rendering carrier updates', () => {
    const adapter = new AcpEventAdapter();
    expect(
      adapter.consume({
        sessionUpdate: 'usage_update',
        used: 100,
        size: 1_000,
        _meta: { verity: { lifecycle: { type: 'compaction', id: 'compact-1' } } },
      }),
    ).toEqual([{ t: 'compaction', boundary: true }]);
    expect(
      adapter.consume({
        sessionUpdate: 'session_info_update',
        _meta: {
          verity: {
            lifecycle: {
              type: 'task',
              id: 'task-1',
              phase: 'started',
              toolUseId: 'tool-1',
            },
          },
        },
      }),
    ).toEqual([{ t: 'task', id: 'task-1', phase: 'started', toolUseId: 'tool-1' }]);
    expect(
      adapter.consume({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'not rendered as operator prose' },
        _meta: { verity: { lifecycle: { type: 'skill', text: 'Skill body' } } },
      }),
    ).toEqual([{ t: 'skill', text: 'Skill body' }]);
  });

  it.each([
    ['five_hour', 'five_hour', undefined],
    ['weekly', 'weekly', undefined],
    ['seven_day', 'weekly', undefined],
    ['seven_day_opus', 'weekly', 'opus'],
    ['seven_day_sonnet', 'weekly', 'sonnet'],
    ['seven_day_overage_included', 'weekly', 'overage_included'],
  ] as const)(
    'maps Claude ACP %s quota metadata to the %s meter',
    (rateLimitType, window, scope) => {
      const adapter = new AcpEventAdapter();
      expect(
        adapter.consume({
          sessionUpdate: 'usage_update',
          used: 10,
          size: 100,
          _meta: {
            '_claude/rateLimit': {
              status: 'allowed_warning',
              resetsAt: 1_783_630_800,
              rateLimitType,
              utilization: 0.725,
            },
          },
        }),
      ).toEqual([
        {
          t: 'rate_limit',
          status: 'allowed_warning',
          resetsAt: 1_783_630_800,
          window,
          usedPercent: 72.5,
          ...(scope === undefined ? {} : { scope }),
          providerLabel: 'Claude',
        },
      ]);
    },
  );

  it.each([
    [0, 0],
    [0.9, 90],
    [0.999, 99.9],
    [1, 100],
  ])(
    'normalizes Claude ACP fractional utilization %s to %s percent',
    (utilization, usedPercent) => {
      const adapter = new AcpEventAdapter();
      expect(
        adapter.consume({
          sessionUpdate: 'usage_update',
          used: 1,
          size: 100,
          _meta: {
            '_claude/rateLimit': {
              status: 'allowed',
              resetsAt: 1_783_630_800,
              rateLimitType: 'seven_day',
              utilization,
            },
          },
        }),
      ).toEqual([
        {
          t: 'rate_limit',
          status: 'allowed',
          resetsAt: 1_783_630_800,
          window: 'weekly',
          usedPercent,
          providerLabel: 'Claude',
        },
      ]);
    },
  );

  it('keeps lifecycle metadata when a Claude quota update shares its carrier', () => {
    const adapter = new AcpEventAdapter();
    expect(
      adapter.consume({
        sessionUpdate: 'usage_update',
        used: 100,
        size: 1_000,
        _meta: {
          verity: { lifecycle: { type: 'compaction', id: 'compact-1' } },
          '_claude/rateLimit': {
            status: 'rejected',
            resetsAt: 1_783_630_800,
            rateLimitType: 'five_hour',
          },
        },
      }),
    ).toEqual([
      { t: 'compaction', boundary: true },
      {
        t: 'rate_limit',
        status: 'rejected',
        resetsAt: 1_783_630_800,
        window: 'five_hour',
        providerLabel: 'Claude',
      },
    ]);
  });

  it.each([
    {},
    { status: 'rejected', resetsAt: 1, rateLimitType: 'overage' },
    { status: 'rejected', resetsAt: 1, rateLimitType: 'seven_day_unknown' },
    { status: 'unknown', resetsAt: 1, rateLimitType: 'five_hour' },
    { status: 'rejected', resetsAt: -1, rateLimitType: 'five_hour' },
    { status: 'rejected', resetsAt: 1.5, rateLimitType: 'five_hour' },
    { status: 'rejected', resetsAt: 1, rateLimitType: 'five_hour', utilization: 1.01 },
  ])('silently drops partial or malformed Claude quota metadata %#', (rateLimit) => {
    const adapter = new AcpEventAdapter();
    expect(
      adapter.consume({
        sessionUpdate: 'usage_update',
        used: 1,
        size: 100,
        _meta: { '_claude/rateLimit': rateLimit },
      }),
    ).toEqual([]);
  });

  it('does not interpret Claude quota metadata for another ACP backend', () => {
    const adapter = new AcpEventAdapter({ metaNamespace: 'codex' });
    expect(
      adapter.consume({
        sessionUpdate: 'usage_update',
        used: 1,
        size: 100,
        _meta: {
          '_claude/rateLimit': {
            status: 'rejected',
            resetsAt: 1,
            rateLimitType: 'five_hour',
          },
        },
      }),
    ).toEqual([]);
  });

  it('maps Codex compaction without treating activity metadata as task lifetime', () => {
    const adapter = new AcpEventAdapter({ metaNamespace: 'codex' });
    expect(
      adapter.consume({
        sessionUpdate: 'tool_call',
        toolCallId: 'compact-1',
        title: 'localized label',
        status: 'completed',
        _meta: { contextCompaction: true },
      }),
    ).toContainEqual({ t: 'compaction', boundary: true });
    const activity = adapter.consume({
      sessionUpdate: 'tool_call',
      toolCallId: 'activity-1',
      title: 'anything',
      status: 'in_progress',
      _meta: {
        codex: {
          subagent: { threadId: 'thread-1', path: 'researcher', activity: 'started' },
        },
      },
    });
    expect(activity).not.toContainEqual(expect.objectContaining({ t: 'task' }));
    expect(activity).toContainEqual(expect.objectContaining({ t: 'tool_call_start' }));
  });

  it('keeps text chunks adjacent when ACP bookkeeping arrives between them', () => {
    const adapter = new AcpEventAdapter();
    const updates: SessionUpdate[] = [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'C' } },
      { sessionUpdate: 'session_info_update', title: 'Smoke test' },
      { sessionUpdate: 'usage_update', used: 1, size: 100 },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'LAUDE' } },
    ];

    expect(updates.flatMap((update) => adapter.consume(update))).toEqual([
      { t: 'text', delta: 'C', parentToolId: undefined },
      { t: 'text', delta: 'LAUDE', parentToolId: undefined },
    ]);
  });

  it('deduplicates ACP tool snapshots and preserves input, output, and lineage', () => {
    const adapter = new AcpEventAdapter();
    expect(
      adapter.consume({
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Read file',
        name: 'Read',
        status: 'in_progress',
        rawInput: { path: 'README.md' },
        _meta: { claudeCode: { parentToolUseId: 'task-1' } },
      }),
    ).toEqual([
      { t: 'tool_call_start', id: 'tool-1', name: 'Read', parentToolId: 'task-1' },
      {
        t: 'tool_call',
        id: 'tool-1',
        name: 'Read',
        input: { path: 'README.md' },
        parentToolId: 'task-1',
      },
    ]);
    expect(
      adapter.consume({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'completed',
        rawInput: { path: 'README.md' },
        rawOutput: 'contents',
        _meta: { claudeCode: { toolName: 'Read', parentToolUseId: 'task-1' } },
      }),
    ).toEqual([
      {
        t: 'tool_result',
        id: 'tool-1',
        output: 'contents',
        isError: false,
        parentToolId: 'task-1',
      },
    ]);
    expect(
      adapter.consume({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'completed',
      }),
    ).toEqual([]);
  });

  it('waits for a delayed terminal tool payload and merges ACP snapshots', () => {
    const adapter = new AcpEventAdapter();
    expect(
      adapter.consume({
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-delayed',
        title: 'Read file',
        status: 'completed',
        content: [],
        rawInput: { path: 'README.md' },
        _meta: { claudeCode: { toolName: 'Read', parentToolUseId: 'task-1' } },
      }),
    ).toEqual([
      { t: 'tool_call_start', id: 'tool-delayed', name: 'Read', parentToolId: 'task-1' },
      {
        t: 'tool_call',
        id: 'tool-delayed',
        name: 'Read',
        input: { path: 'README.md' },
        parentToolId: 'task-1',
      },
    ]);
    expect(
      adapter.consume({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-delayed',
        rawOutput: 'contents',
      }),
    ).toEqual([
      {
        t: 'tool_result',
        id: 'tool-delayed',
        output: 'contents',
        isError: false,
        parentToolId: 'task-1',
      },
    ]);
    expect(adapter.flush()).toEqual([]);
  });

  it('flushes a terminal tool snapshot when no payload update follows', () => {
    const adapter = new AcpEventAdapter();
    adapter.consume({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-empty',
      status: 'failed',
    });
    expect(adapter.flush()).toEqual([
      { t: 'tool_call', id: 'tool-empty', name: 'Tool', input: {}, parentToolId: undefined },
      {
        t: 'tool_result',
        id: 'tool-empty',
        output: '',
        isError: true,
        parentToolId: undefined,
      },
    ]);
  });

  it('reads lineage and tool payloads from the configured _meta namespace only', () => {
    // Each ACP adapter namespaces its extensions under its own `_meta` key —
    // `claudeCode` for the Claude adapter, `codex` for codex-acp. Reading the
    // wrong one would silently drop lineage and tool output.
    const adapter = new AcpEventAdapter({ metaNamespace: 'codex' });
    expect(
      adapter.consume({
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Read file',
        name: 'Read',
        status: 'completed',
        rawInput: { path: 'README.md' },
        rawOutput: 'contents',
        _meta: { codex: { parentToolUseId: 'task-1' }, claudeCode: { parentToolUseId: 'other' } },
      }),
    ).toEqual([
      { t: 'tool_call_start', id: 'tool-1', name: 'Read', parentToolId: 'task-1' },
      {
        t: 'tool_call',
        id: 'tool-1',
        name: 'Read',
        input: { path: 'README.md' },
        parentToolId: 'task-1',
      },
      {
        t: 'tool_result',
        id: 'tool-1',
        output: 'contents',
        isError: false,
        parentToolId: 'task-1',
      },
    ]);
  });

  it('lets a profile name a tool the adapter itself leaves unnamed', () => {
    // codex-acp sets no `name` and its `title` for a command execution IS the
    // command line, so without a resolver every Bash call would be named after
    // its own arguments.
    const adapter = new AcpEventAdapter({
      metaNamespace: 'codex',
      resolveToolName: (tool) => (tool.kind === 'execute' ? 'Bash' : undefined),
    });
    expect(
      adapter.consume({
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-2',
        kind: 'execute',
        title: 'ls -la',
        status: 'in_progress',
        rawInput: { command: 'ls -la' },
      }),
    ).toEqual([
      { t: 'tool_call_start', id: 'tool-2', name: 'Bash', parentToolId: undefined },
      {
        t: 'tool_call',
        id: 'tool-2',
        name: 'Bash',
        input: { command: 'ls -la' },
        parentToolId: undefined,
      },
    ]);
    // An unmapped kind still falls back to ACP's own title.
    expect(
      adapter.consume({
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-3',
        kind: 'other',
        title: 'Something else',
        status: 'in_progress',
      }),
    ).toEqual([
      { t: 'tool_call_start', id: 'tool-3', name: 'Something else', parentToolId: undefined },
    ]);
  });

  it('lifts Verity quick actions only after the ACP message is complete', () => {
    expect(
      finalAcpTextEvents(
        'Choose.\n```verity:choices\n{"options":[{"label":"A"},{"label":"B"}]}\n```',
      ),
    ).toEqual([
      { t: 'text', delta: 'Choose.' },
      { t: 'choices', options: [{ label: 'A' }, { label: 'B' }] },
    ]);
  });

  it('streams prose while hiding a choices opener split across ACP chunks', () => {
    const stream = new AcpTextStream();
    expect(stream.push('Working now.\n\n```verity:cho')).toEqual([
      { t: 'text', delta: 'Working now.' },
    ]);
    expect(stream.push('ices\n{"options":[{"label":"Continue"}]}\n```')).toEqual([]);
    expect(stream.flush()).toEqual([{ t: 'choices', options: [{ label: 'Continue' }] }]);
  });

  it('hides and lifts an agent-loop contract split across ACP chunks', () => {
    const stream = new AcpTextStream();
    const proposal = {
      loopId: '11111111-1111-4111-8111-111111111111',
      name: 'Daily check',
      script: 'npm test',
      schedule: { kind: 'daily', hour: 9, minute: 0 },
    };
    expect(stream.push('Configured.\n```verity:agent-')).toEqual([
      { t: 'text', delta: 'Configured.' },
    ]);
    expect(stream.push(`loop\n${JSON.stringify(proposal)}\n\`\`\``)).toEqual([]);
    expect(stream.flush()).toEqual([{ t: 'agent_loop_proposal', proposal }]);
  });
});
