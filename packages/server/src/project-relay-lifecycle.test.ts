import { describe, expect, it, vi } from 'vitest';

import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import type { ProjectInternalUnixListener } from './internal-listener.js';
import type { ProjectClaudeUnixListener } from './project-claude-unix-listener.js';
import { ProjectRelayLifecycle } from './project-relay-lifecycle.js';
import type { SigningCapabilityRegistry } from './signing-capability.js';

const binding = {
  projectId: 'p1',
  owner: 'heey-global',
  repo: 'verity',
  containerGeneration: 'generation-1',
  claudeGateway: { host: 'gateway.internal', port: 9443 },
};

function harness() {
  const calls: string[] = [];
  const brokerClose = vi.fn(async () => {
    calls.push('broker.close');
  });
  const brokerListener: ProjectInternalUnixListener = {
    socketPath: '/run/verity/project/broker.sock',
    identity: { projectId: 'p1', containerGeneration: 'generation-1' },
    close: brokerClose,
  };
  const claudeClose = vi.fn(async () => {
    calls.push('claude.close');
  });
  const claudeListener: ProjectClaudeUnixListener = {
    socketPath: '/run/verity/project/claude.sock',
    identity: { projectId: 'p1', containerGeneration: 'generation-1' },
    close: claudeClose,
  };
  const signing = {
    issue: vi.fn(async () => {
      calls.push('signing.issue');
      return 'sign-cap';
    }),
    resolve: vi.fn(),
    revokeProject: vi.fn(async () => {
      calls.push('signing.revoke');
    }),
  } satisfies SigningCapabilityRegistry;
  const github = {
    issue: vi.fn(async () => {
      calls.push('github.issue');
      return 'gh-cap';
    }),
    resolve: vi.fn(),
    revokeProject: vi.fn(async () => {
      calls.push('github.revoke');
    }),
  } satisfies GhTokenCapabilityRegistry;
  const runtime = {
    close: vi.fn(async () => {
      calls.push('runtime.close');
    }),
  };
  const startBrokerListener = vi.fn(async () => {
    calls.push('broker.start');
    return brokerListener;
  });
  const startClaudeListener = vi.fn(async () => {
    calls.push('claude.start');
    return claudeListener;
  });
  const startRelay = vi.fn(async () => {
    calls.push('runtime.start');
    return runtime;
  });
  const lifecycle = new ProjectRelayLifecycle({
    signingCapabilities: signing,
    githubCapabilities: github,
    startBrokerListener,
    startClaudeListener,
    startRelay,
  });
  return {
    brokerListener,
    brokerClose,
    calls,
    claudeClose,
    claudeListener,
    github,
    lifecycle,
    runtime,
    signing,
    startBrokerListener,
    startClaudeListener,
    startRelay,
  };
}

describe('ProjectRelayLifecycle', () => {
  it('activates a generation-bound listener and both capabilities before the relay', async () => {
    const h = harness();
    await expect(h.lifecycle.start(binding)).resolves.toEqual({
      identity: { projectId: 'p1', containerGeneration: 'generation-1' },
      signingCapability: 'sign-cap',
      githubCapability: 'gh-cap',
    });
    expect(h.calls).toEqual([
      'broker.start',
      'claude.start',
      'signing.issue',
      'github.issue',
      'runtime.start',
    ]);
    expect(h.startRelay).toHaveBeenCalledWith({
      identity: { projectId: 'p1', containerGeneration: 'generation-1' },
      brokerSocketPath: '/run/verity/project/broker.sock',
      claudeSocketPath: '/run/verity/project/claude.sock',
    });
  });

  it('reports ownership only between a completed start and its teardown', async () => {
    // What the reconciler reads to tell a live relay from an orphaned sandbox: a
    // fresh process owns nothing, so every capability a predecessor wrote into a
    // still-running sandbox is already dead.
    const h = harness();
    expect(h.lifecycle.isActive('p1')).toBe(false);
    await h.lifecycle.start(binding);
    expect(h.lifecycle.isActive('p1')).toBe(true);
    expect(h.lifecycle.isActive('p1', 'generation-1')).toBe(true);
    expect(h.lifecycle.isActive('p1', 'stale-generation')).toBe(false);
    expect(h.lifecycle.isActive('some-other-project')).toBe(false);
    await h.lifecycle.stop('p1');
    expect(h.lifecycle.isActive('p1')).toBe(false);
  });

  it('resumes an existing generation without rotating its durable capabilities', async () => {
    const h = harness();
    await h.lifecycle.resume(binding);
    expect(h.lifecycle.isActive('p1', 'generation-1')).toBe(true);
    expect(h.signing.issue).not.toHaveBeenCalled();
    expect(h.github.issue).not.toHaveBeenCalled();
    expect(h.calls).toEqual(['broker.start', 'claude.start', 'runtime.start']);
    expect(h.startRelay).toHaveBeenCalledWith(expect.objectContaining({ resumeExisting: true }));
  });

  it('does not revoke an existing sandbox capability when resume fails', async () => {
    const h = harness();
    h.startRelay.mockRejectedValueOnce(new Error('relay unavailable'));
    await expect(h.lifecycle.resume(binding)).rejects.toThrow('relay unavailable');
    expect(h.signing.revokeProject).not.toHaveBeenCalled();
    expect(h.github.revokeProject).not.toHaveBeenCalled();
    expect(h.lifecycle.isActive('p1')).toBe(false);
  });

  it('suspends for a Server handoff without stopping the relay or revoking capabilities', async () => {
    const h = harness();
    await h.lifecycle.start(binding);
    await h.lifecycle.suspend();
    expect(h.runtime.close).not.toHaveBeenCalled();
    expect(h.signing.revokeProject).not.toHaveBeenCalled();
    expect(h.github.revokeProject).not.toHaveBeenCalled();
    expect(h.calls).toEqual(expect.arrayContaining(['broker.close', 'claude.close']));
    expect(h.lifecycle.isActive('p1')).toBe(false);
  });

  it('retains a relay whose listener failed to close so suspend can retry it', async () => {
    const h = harness();
    await h.lifecycle.start(binding);
    h.brokerClose.mockRejectedValueOnce(new Error('close failed'));
    await expect(h.lifecycle.suspend()).rejects.toThrow(/suspend failed/);
    expect(h.lifecycle.isActive('p1')).toBe(true);
    await expect(h.lifecycle.suspend()).resolves.toBeUndefined();
    expect(h.lifecycle.isActive('p1')).toBe(false);
    expect(h.brokerClose).toHaveBeenCalledTimes(2);
    expect(h.claudeClose).toHaveBeenCalledTimes(1);
  });

  it('fails closed before opening anything when a Codex gateway has no listener', async () => {
    const h = harness();
    await expect(
      h.lifecycle.start({
        ...binding,
        codexGateway: { host: 'codex.internal', port: 9444 },
      }),
    ).rejects.toThrow(/Codex gateway has no listener/);
    expect(h.startBrokerListener).not.toHaveBeenCalled();
  });

  it('names the generation it holds so the GC never sweeps a relay in use', async () => {
    // The GC decides from the daemon's listing, where a provision that has not
    // created its sandbox yet is invisible. This is the authoritative answer it
    // consults instead — and it must empty out again on teardown, or a superseded
    // relay would be protected for the life of the process.
    const h = harness();
    expect(h.lifecycle.heldRelays()).toEqual([]);
    await h.lifecycle.start(binding);
    expect(h.lifecycle.heldRelays()).toEqual([
      { projectId: binding.projectId, containerGeneration: binding.containerGeneration },
    ]);
    await h.lifecycle.stop('p1');
    expect(h.lifecycle.heldRelays()).toEqual([]);
  });

  it('holds the generation from before the relay exists, not just after it is up', async () => {
    // `startRelay` creates the container. If the hold only began once that call
    // returned, a start stalled inside it would leave a real relay container that
    // no sandbox names and this process does not report — collectable by the GC
    // the moment it ages past the grace period, while the provision still needs it.
    const h = harness();
    let releaseRelay!: () => void;
    h.startRelay.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRelay = () => resolve(h.runtime);
        }),
    );

    const started = h.lifecycle.start(binding);
    await vi.waitFor(() => expect(h.startRelay).toHaveBeenCalled());
    expect(h.lifecycle.heldRelays()).toEqual([
      { projectId: binding.projectId, containerGeneration: binding.containerGeneration },
    ]);
    // Still only a claim: ownership is what the reconciler reads, and it must not
    // report a start that has not finished.
    expect(h.lifecycle.isActive('p1')).toBe(false);

    releaseRelay();
    await started;
    expect(h.lifecycle.heldRelays()).toEqual([
      { projectId: binding.projectId, containerGeneration: binding.containerGeneration },
    ]);
  });

  it('reports no ownership after a relay start failed and rolled back', async () => {
    const h = harness();
    h.startRelay.mockRejectedValueOnce(new Error('docker start failed'));
    await expect(h.lifecycle.start(binding)).rejects.toThrow('docker start failed');
    expect(h.lifecycle.isActive('p1')).toBe(false);
  });

  it('rolls back the listener and all capabilities when relay start fails', async () => {
    const h = harness();
    h.startRelay.mockRejectedValueOnce(new Error('docker start failed'));
    await expect(h.lifecycle.start(binding)).rejects.toThrow('docker start failed');
    expect(h.calls).toEqual([
      'broker.start',
      'claude.start',
      'signing.issue',
      'github.issue',
      'signing.revoke',
      'github.revoke',
      'broker.close',
      'claude.close',
    ]);
  });

  it('closes the broker listener when the Claude listener cannot start', async () => {
    const h = harness();
    h.startClaudeListener.mockRejectedValueOnce(new Error('Claude socket failed'));

    await expect(h.lifecycle.start(binding)).rejects.toThrow('Claude socket failed');
    expect(h.calls).toEqual(['broker.start', 'signing.revoke', 'github.revoke', 'broker.close']);
    expect(h.signing.issue).not.toHaveBeenCalled();
    expect(h.github.issue).not.toHaveBeenCalled();
    expect(h.startRelay).not.toHaveBeenCalled();
  });

  it('revokes both capabilities before tearing down runtime and listener', async () => {
    const h = harness();
    await h.lifecycle.start(binding);
    h.calls.length = 0;
    await h.lifecycle.stop('p1');
    expect(h.calls).toEqual([
      'signing.revoke',
      'github.revoke',
      'runtime.close',
      'broker.close',
      'claude.close',
    ]);
  });

  it('continues revocation and reports teardown failures as an aggregate', async () => {
    const h = harness();
    await h.lifecycle.start(binding);
    h.runtime.close.mockRejectedValueOnce(new Error('relay stuck'));
    h.brokerListener.close = vi.fn(async () => {
      h.calls.push('broker.close');
      throw new Error('listener stuck');
    });
    await expect(h.lifecycle.stop('p1')).rejects.toBeInstanceOf(AggregateError);
    expect(h.signing.revokeProject).toHaveBeenCalledWith('p1');
    expect(h.github.revokeProject).toHaveBeenCalledWith('p1');
  });

  it('refuses duplicate activation and still permits idempotent revocation', async () => {
    const h = harness();
    await h.lifecycle.start(binding);
    await expect(h.lifecycle.start(binding)).rejects.toThrow('project relay already active');
    await h.lifecycle.stop('p1');
    await expect(h.lifecycle.stop('p1')).resolves.toBeUndefined();
  });

  it('serializes concurrent starts so only one project relay can activate', async () => {
    const h = harness();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.startBrokerListener.mockImplementationOnce(async () => {
      h.calls.push('broker.start');
      await blocked;
      return h.brokerListener;
    });
    const first = h.lifecycle.start(binding);
    const second = h.lifecycle.start({ ...binding, containerGeneration: 'generation-2' });
    release();
    await expect(first).resolves.toMatchObject({
      identity: { containerGeneration: 'generation-1' },
    });
    await expect(second).rejects.toThrow('project relay already active');
    expect(h.startBrokerListener).toHaveBeenCalledOnce();
  });

  it('retains failed teardown handles and retries without reopening closed resources', async () => {
    const h = harness();
    await h.lifecycle.start(binding);
    h.runtime.close.mockRejectedValueOnce(new Error('relay stuck'));
    await expect(h.lifecycle.stop('p1')).rejects.toBeInstanceOf(AggregateError);
    await expect(h.lifecycle.start(binding)).rejects.toThrow('project relay already active');
    await expect(h.lifecycle.stop('p1')).resolves.toBeUndefined();
    expect(h.runtime.close).toHaveBeenCalledTimes(2);
    expect(h.calls.filter((call) => call === 'broker.close')).toHaveLength(1);
  });

  it('retries a failed Claude close without reclosing successful resources', async () => {
    const h = harness();
    const closeClaude = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('Claude listener stuck'))
      .mockResolvedValueOnce();
    h.claudeListener.close = closeClaude;
    await h.lifecycle.start(binding);

    await expect(h.lifecycle.stop('p1')).rejects.toBeInstanceOf(AggregateError);
    await expect(h.lifecycle.start(binding)).rejects.toThrow('project relay already active');
    await expect(h.lifecycle.stop('p1')).resolves.toBeUndefined();
    expect(closeClaude).toHaveBeenCalledTimes(2);
    expect(h.runtime.close).toHaveBeenCalledOnce();
    expect(h.calls.filter((call) => call === 'broker.close')).toHaveLength(1);
  });

  it('surfaces rollback failures and keeps their handles retryable', async () => {
    const h = harness();
    h.startRelay.mockRejectedValueOnce(new Error('docker start failed'));
    const listenerClose = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('listener stuck'))
      .mockResolvedValueOnce();
    h.brokerListener.close = listenerClose;
    await expect(h.lifecycle.start(binding)).rejects.toBeInstanceOf(AggregateError);
    await expect(h.lifecycle.start(binding)).rejects.toThrow('project relay already active');
    await expect(h.lifecycle.stop('p1')).resolves.toBeUndefined();
    expect(listenerClose).toHaveBeenCalledTimes(2);
  });

  it('starts every teardown action even while the first revocation is blocked', async () => {
    const h = harness();
    await h.lifecycle.start(binding);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.signing.revokeProject.mockImplementationOnce(async () => {
      h.calls.push('signing.revoke');
      await blocked;
    });
    const stopping = h.lifecycle.stop('p1');
    await vi.waitFor(() => {
      expect(h.github.revokeProject).toHaveBeenCalledWith('p1');
      expect(h.runtime.close).toHaveBeenCalledOnce();
      expect(h.calls.filter((call) => call === 'broker.close')).toHaveLength(1);
    });
    release();
    await expect(stopping).resolves.toBeUndefined();
  });

  it('queues stop behind an in-flight start for the same project', async () => {
    const h = harness();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.startRelay.mockImplementationOnce(async () => {
      h.calls.push('runtime.start');
      await blocked;
      return h.runtime;
    });
    const starting = h.lifecycle.start(binding);
    const stopping = h.lifecycle.stop('p1');
    await Promise.resolve();
    expect(h.signing.revokeProject).not.toHaveBeenCalled();
    release();
    await expect(starting).resolves.toBeDefined();
    await expect(stopping).resolves.toBeUndefined();
  });

  it('closes every active project relay during server shutdown', async () => {
    const h = harness();
    await h.lifecycle.start(binding);

    await expect(h.lifecycle.close()).resolves.toBeUndefined();
    expect(h.runtime.close).toHaveBeenCalledOnce();
    expect(h.signing.revokeProject).toHaveBeenCalledWith('p1');
    expect(h.github.revokeProject).toHaveBeenCalledWith('p1');
  });

  it('waits for an in-flight start and tears it down during shutdown', async () => {
    const h = harness();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.startRelay.mockImplementationOnce(async () => {
      await blocked;
      return h.runtime;
    });
    const starting = h.lifecycle.start(binding);
    await vi.waitFor(() => expect(h.startRelay).toHaveBeenCalledOnce());
    const closing = h.lifecycle.close();
    let closeSettled = false;
    void closing.finally(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    await expect(h.lifecycle.start(binding)).rejects.toThrow('lifecycle is closed');

    release();
    await expect(starting).resolves.toBeDefined();
    await expect(closing).resolves.toBeUndefined();
    expect(h.runtime.close).toHaveBeenCalledOnce();
    expect(h.signing.revokeProject).toHaveBeenCalledWith('p1');
  });
});
