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
