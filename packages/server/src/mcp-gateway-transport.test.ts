import { describe, expect, it, vi } from 'vitest';
import { projectTransportFetch } from './project-transport-authority.js';
import { call, harness, resultOf, SANDBOX_USER } from './mcp-gateway.test-helper.js';

const IDENTITY = {
  projectId: 'p1',
  userId: SANDBOX_USER,
  projectDefault: true,
  containerGeneration: 'g1',
};

describe('MCP gateway — project transport authority', () => {
  it('binds provider requests to the listener generation and blocks work after retirement', async () => {
    const generation = new AbortController();
    const provider = vi.fn(async () => 'ok');
    const { gateway } = harness({
      invokeTool: async () => {
        await projectTransportFetch(provider, 'https://example.test/first', {});
        generation.abort();
        return projectTransportFetch(provider, 'https://example.test/second', {});
      },
    });
    const response = await gateway.handle({
      projectId: 'p1',
      token: 'session-token',
      body: call(),
      transport: {
        identity: {
          projectId: 'p1',
          userId: SANDBOX_USER,
          projectDefault: true,
          containerGeneration: 'g1',
        },
        signal: generation.signal,
      },
    });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(resultOf(response.body).isError).toBe(true);
  });

  it('revalidates the initiating user after asynchronous tool credential work', async () => {
    let revoked = false;
    const provider = vi.fn(async () => 'ok');
    const { gateway } = harness({
      authorizeExecution: async () => {
        if (revoked) throw new Error('user revoked');
      },
      invokeTool: async () => {
        revoked = true;
        return projectTransportFetch(provider, 'https://example.test', {});
      },
    });
    const response = await gateway.handle({
      projectId: 'p1',
      token: 'session-token',
      body: call(),
      transport: {
        identity: {
          projectId: 'p1',
          userId: SANDBOX_USER,
          projectDefault: true,
          containerGeneration: 'g1',
        },
        signal: new AbortController().signal,
      },
    });
    expect(provider).not.toHaveBeenCalled();
    expect(resultOf(response.body).isError).toBe(true);
  });

  // Each in-flight project call re-runs its authority check every 500 ms against the
  // database pool. A caller that timed out used to leave that loop, and the provider work
  // behind it, running until the tool finished on its own.
  it('stops authority checks and provider work once the caller disconnects', async () => {
    const caller = new AbortController();
    const provider = vi.fn(async () => 'ok');
    let checks = 0;
    let disconnectedChecks = 0;
    const { gateway } = harness({
      authorizeExecution: async () => {
        checks += 1;
        if (caller.signal.aborted) disconnectedChecks += 1;
      },
      invokeTool: async () => {
        await projectTransportFetch(provider, 'https://example.test/first', {});
        caller.abort(new Error('Tool caller disconnected.'));
        // Longer than the re-authorization interval: a live poll would run in here.
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        return projectTransportFetch(provider, 'https://example.test/second', {});
      },
    });
    const response = await gateway.handle({
      projectId: 'p1',
      token: 'session-token',
      body: call(),
      signal: caller.signal,
      transport: { identity: IDENTITY, signal: new AbortController().signal },
    });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(checks).toBeGreaterThan(0);
    expect(disconnectedChecks).toBe(0);
    expect(resultOf(response.body).isError).toBe(true);
  });
});
