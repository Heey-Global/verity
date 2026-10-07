import { describe, expect, it, vi } from 'vitest';
import { createControlDiagnosticsTool } from './control-diagnostics-tool.js';

const input = {
  projectId: 'verity-control',
  sessionId: 'control',
  turnId: 'turn',
  invocationId: 'call',
  callId: 'call',
  request: {},
};
function setup() {
  return {
    authorizeCaller: vi.fn(async () => {}),
    readProgress: vi.fn(async () => ({
      sessionId: 'target',
      projectId: 'project',
      lifecycle: 'failed',
      lastActivityAt: 123,
      projectionTruncated: true,
      diagnostics: [
        {
          seq: 1,
          ts: 123,
          source: 'mcp',
          outcome: 'failed',
          phase: 'tool_call',
          code: 503,
          backend: 'private',
          message: 'secret',
        },
      ],
      publishedSummary: { summary: 'private message' },
      blocker: { summary: 'secret' },
    })),
    version: '1.2.3',
    pushEnabled: false,
    publicPreviewsEnabled: () => false,
  };
}
describe('Control diagnostics', () => {
  it('reports unavailable evidence without inventing health or a cause', async () => {
    const deps = setup();
    const result = await createControlDiagnosticsTool(deps)(input);
    expect(result.secretJobRuntime).toEqual({ state: 'unknown' });
    expect(result.uplink).toEqual({ state: 'unknown' });
    expect(result.session).toBeNull();
    expect(result.server).toEqual({ version: deps.version });
    expect(deps.readProgress).not.toHaveBeenCalled();
  });
  it('projects only technical evidence even when sources gain private fields', async () => {
    const result = await createControlDiagnosticsTool({
      ...setup(),
      runtimeReadiness: async () => {},
      uplinkDiagnostics: () => ({
        control: 'rejected',
        sharing: 'unavailable',
        remoteControl: 'unavailable',
        reason: 'revoked',
        remoteStreams: ['secret'],
        token: 'secret',
      }),
    })({ ...input, request: { sessionId: 'target' } });
    expect(result.session?.diagnostics).toEqual([
      { seq: 1, ts: 123, source: 'mcp', outcome: 'failed', phase: 'tool_call', code: 503 },
    ]);
    expect(result.secretJobRuntime).toEqual({ state: 'ready' });
    expect(result.uplink).toEqual({
      control: 'rejected',
      sharing: 'unavailable',
      remoteControl: 'unavailable',
      reason: 'revoked',
    });
    expect(JSON.stringify(result)).not.toMatch(/"secret"|private message|private"/u);
  });
  it('contains source exceptions and distinguishes failure from unknown', async () => {
    const result = await createControlDiagnosticsTool({
      ...setup(),
      runtimeReadiness: async () => {
        throw new Error('credential');
      },
      uplinkDiagnostics: () => {
        throw new Error('credential');
      },
      publicPreviewsEnabled: () => {
        throw new Error('credential');
      },
    })(input);
    expect(result.secretJobRuntime).toEqual({ state: 'not_ready' });
    expect(result.capabilities.publicPreviewsEnabled).toBeNull();
    expect(result.uplink).toEqual({ state: 'unknown' });
    expect(JSON.stringify(result)).not.toContain('credential');
  });
  it('checks authority before reads and again before returning evidence', async () => {
    const deps = setup();
    deps.authorizeCaller.mockRejectedValueOnce(new Error('denied'));
    await expect(createControlDiagnosticsTool(deps)(input)).rejects.toThrow('denied');
    expect(deps.readProgress).not.toHaveBeenCalled();
    const changed = setup();
    changed.authorizeCaller
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('changed'));
    await expect(createControlDiagnosticsTool(changed)(input)).rejects.toThrow('changed');
  });
  it('rejects arbitrary diagnostic commands', async () => {
    await expect(
      createControlDiagnosticsTool(setup())({ ...input, request: { command: 'restart' } }),
    ).rejects.toThrow();
  });
});

it('scopes Matrix evidence to the requested project and drops free-form source fields', async () => {
  const readMatrixDiagnostics = vi.fn(async () => ({
    projectId: 'project',
    truncated: false,
    sources: [
      {
        accountId: '@verity:example.test',
        sourceId: '!room:example.test',
        status: 'active',
        lastIngestedAt: null,
        lastError: 'private message',
        importDiagnostics: [
          {
            sourceId: '!room:example.test',
            eventId: '$event',
            occurredAt: '2026-01-01T00:00:00Z',
            lastAttemptAt: '2026-01-01T00:01:00Z',
            attempts: 2,
            httpStatus: 422,
            code: 'target_message_not_found',
          },
        ],
      },
    ],
  }));
  const result = await createControlDiagnosticsTool({ ...setup(), readMatrixDiagnostics })({
    ...input,
    request: { projectId: 'project' },
  });
  expect(readMatrixDiagnostics).toHaveBeenCalledWith('project', undefined);
  expect(result.matrix?.sources[0]?.importDiagnostics[0]?.eventId).toBe('$event');
  expect(JSON.stringify(result)).not.toContain('private message');
});

it('requires an explicit project for an event receipt and omits persisted message content', async () => {
  const matrixEvent = {
    accountId: '@verity:example.test',
    sourceId: '!room:example.test',
    eventId: '$event',
  };
  const readMatrixDiagnostics = vi.fn(async () => ({
    projectId: 'project',
    sources: [],
    truncated: false,
    event: {
      stored: true,
      kind: 'message',
      targetEventId: null,
      occurredAt: '2026-01-01T00:00:00Z',
      body: 'private message',
      sender: 'private sender',
    },
  }));
  const tool = createControlDiagnosticsTool({ ...setup(), readMatrixDiagnostics });
  await expect(tool({ ...input, request: { matrixEvent } })).rejects.toThrow('requires projectId');
  expect(readMatrixDiagnostics).not.toHaveBeenCalled();
  const result = await tool({ ...input, request: { projectId: 'project', matrixEvent } });
  expect(readMatrixDiagnostics).toHaveBeenCalledWith('project', matrixEvent);
  expect(result.matrix?.event?.stored).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/private message|private sender/);
});

it('checks project authority before reading runtime evidence and rechecks after reading', async () => {
  const authorizeDiagnosticProject = vi.fn(async () => {});
  const readRuntimeDiagnostics = vi.fn(async () => ({}));
  const tool = createControlDiagnosticsTool({
    ...setup(),
    authorizeDiagnosticProject,
    readRuntimeDiagnostics,
  });
  await tool({ ...input, request: { projectId: 'project' } });
  expect(authorizeDiagnosticProject).toHaveBeenCalledTimes(2);
  expect(readRuntimeDiagnostics).toHaveBeenCalledWith('project', undefined);
  expect(authorizeDiagnosticProject.mock.invocationCallOrder[0]).toBeLessThan(
    readRuntimeDiagnostics.mock.invocationCallOrder[0]!,
  );
  authorizeDiagnosticProject.mockRejectedValueOnce(new Error('hidden project'));
  readRuntimeDiagnostics.mockClear();
  await expect(tool({ ...input, request: { projectId: 'hidden' } })).rejects.toThrow(
    'hidden project',
  );
  expect(readRuntimeDiagnostics).not.toHaveBeenCalled();
});

it('rejects broad or arbitrary runtime requests before invoking diagnostic sources', async () => {
  const readRuntimeDiagnostics = vi.fn(async () => ({}));
  const tool = createControlDiagnosticsTool({ ...setup(), readRuntimeDiagnostics });
  await expect(
    tool({ ...input, request: { runtime: { command: 'journalctl' } } }),
  ).rejects.toThrow();
  await expect(
    tool({ ...input, request: { runtime: { since: '2000-01-01T00:00:00Z' } } }),
  ).rejects.toThrow('24 hours');
  expect(readRuntimeDiagnostics).not.toHaveBeenCalled();
});

it('contains runtime source failures without exposing exceptions or invalid source payloads', async () => {
  const result = await createControlDiagnosticsTool({
    ...setup(),
    readRuntimeDiagnostics: async () => {
      throw new Error('credential');
    },
  })(input);
  expect(result.infrastructure).toEqual({ state: 'failed' });
  expect(JSON.stringify(result)).not.toContain('credential');
});
