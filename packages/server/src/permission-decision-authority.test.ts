import type { AgentEvent } from '@verity/events';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import {
  classifyPermissionTool,
  mayAllowPermission,
  pendingPermissionTool,
} from './permission-decision-authority.js';

describe('classifyPermissionTool', () => {
  it('recognizes the brokered tools bare and behind an MCP server prefix', () => {
    expect(classifyPermissionTool('verity_secret_run')).toBe('secret');
    expect(classifyPermissionTool('mcp__verity__verity_secret_run')).toBe('secret');
    expect(classifyPermissionTool('verity_http_request')).toBe('network');
    expect(classifyPermissionTool('mcp__verity__verity_http_request')).toBe('network');
  });

  it('leaves other tools general, including near-miss names', () => {
    for (const tool of [
      'Bash',
      'verity_send_session_message',
      'xverity_secret_run',
      'verity_secret_run_log',
    ])
      expect(classifyPermissionTool(tool)).toBe('general');
  });
});

/** A session log of `count` filler events with a permission prompt at `at` (1-based seq). */
function source(options: {
  pending: string[];
  detached?: { toolUseId: string; tool: string }[];
  count?: number;
  prompt?: { at: number; id: string; tool: string };
}) {
  const count = options.count ?? 5;
  const events = Array.from({ length: count }, (_, i) => {
    const seq = i + 1;
    const event: AgentEvent =
      options.prompt?.at === seq
        ? {
            t: 'permission',
            id: options.prompt.id,
            tool: options.prompt.tool,
            input: {},
            riskClass: 'ask',
          }
        : { t: 'text', delta: 'filler' };
    return { seq, ts: seq, event };
  });
  const getEventsBeforeSeq = vi.fn(async (_id: string, limit: number, before?: number) => {
    const older = events.filter((e) => before === undefined || e.seq < before);
    return { events: older.slice(-limit), hasMore: older.length > limit };
  });
  return {
    store: {
      getEventsBeforeSeq,
      isActiveAdministrator: vi.fn(async () => false),
      getSession: vi.fn(async () => ({ sessionId: 's', projectId: 'p' }) as never),
      hasProjectPermission: vi.fn(async () => false),
    },
    conductor: {
      pendingPermissions: () => [
        ...options.pending,
        ...(options.detached ?? []).map((d) => d.toolUseId),
      ],
      detachedPermissionRequests: () => options.detached ?? [],
    },
  };
}

describe('pendingPermissionTool', () => {
  it('finds a prompt several pages back in the session log', async () => {
    const deps = source({
      pending: ['t1'],
      count: 450,
      prompt: { at: 3, id: 't1', tool: 'verity_secret_run' },
    });
    expect(await pendingPermissionTool(deps, 's', 't1')).toBe('verity_secret_run');
    expect(deps.store.getEventsBeforeSeq).toHaveBeenCalledTimes(3);
  });

  it('answers a detached prompt from the conductor without reading the log', async () => {
    const deps = source({
      pending: [],
      detached: [{ toolUseId: 'd1', tool: 'verity_http_request' }],
    });
    expect(await pendingPermissionTool(deps, 's', 'd1')).toBe('verity_http_request');
    expect(deps.store.getEventsBeforeSeq).not.toHaveBeenCalled();
  });

  it('separates a prompt the conductor does not hold from one whose event is missing', async () => {
    expect(await pendingPermissionTool(source({ pending: [] }), 's', 'gone')).toBeUndefined();
    expect(await pendingPermissionTool(source({ pending: ['t1'] }), 's', 't1')).toBeNull();
  });
});

describe('mayAllowPermission', () => {
  const editor = { localUserId: 'mara', headers: {} } as unknown as FastifyRequest;

  it('needs Code to allow a secret prompt', async () => {
    const deps = source({
      pending: ['t1'],
      prompt: { at: 2, id: 't1', tool: 'mcp__verity__verity_secret_run' },
    });
    expect(await mayAllowPermission(deps, editor, 's', 't1')).toBe(false);
    deps.store.hasProjectPermission.mockResolvedValue(true);
    expect(await mayAllowPermission(deps, editor, 's', 't1')).toBe(true);
    expect(deps.store.hasProjectPermission).toHaveBeenCalledWith('mara', 'p', 'code');
  });

  it('needs Code when an open prompt cannot be identified', async () => {
    expect(await mayAllowPermission(source({ pending: ['t1'] }), editor, 's', 't1')).toBe(false);
  });

  it('leaves general prompts and linked-message approvals with execute', async () => {
    const general = source({ pending: ['t1'], prompt: { at: 2, id: 't1', tool: 'Bash' } });
    expect(await mayAllowPermission(general, editor, 's', 't1')).toBe(true);
    expect(await mayAllowPermission(source({ pending: [] }), editor, 's', 'link-1')).toBe(true);
  });
});
