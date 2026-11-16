import { observeProjectActivity, activityReasons } from './project-idle-sleep.js';
import type { PublicPreviewShareRecord } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';
import type { PreviewShareManagerOptions } from './preview-share-manager.js';
import { previewTargetIsLive } from './preview-target-activity.js';

function fixture() {
  const share = {
    id: 'share',
    projectId: 'p',
    sessionId: 's',
    targetKind: 'dev-server',
    targetPort: 3000,
    state: 'active',
    expiresAt: new Date('2030-01-01'),
    managedInstanceId: null,
  } as PublicPreviewShareRecord;
  const project = { id: 'p', containerName: 'sandbox', state: 'active' };
  const inspectContainer = vi.fn(async () => ({ running: true }));
  const options = {
    store: {
      getProject: async () => project,
      getSession: async () => ({ projectId: 'p', worktree: '/work/session' }),
      getDevServer: async () => ({ projectId: 'p', containerPort: '3000' }),
      managedDevServers: {
        getInstance: async () => ({
          id: 'm',
          projectId: 'p',
          sessionId: 's',
          sandboxPort: 3000,
          desired: 'running',
          state: 'running',
        }),
      },
    },
    docker: { inspectContainer },
    now: () => new Date('2026-11-16'),
    isDevServerRunning: vi.fn(async () => true),
    listListeningProcesses: vi.fn(async () => [{ instanceId: 'm', port: 3000 }]),
  } as unknown as PreviewShareManagerOptions;
  const probes = {
    sandbox: vi.fn(async () => project as never),
    sessionPort: vi.fn(async () => true),
    staticDirectory: vi.fn(async () => {}),
  };
  return {
    share,
    options,
    probes,
    inspectContainer,
    live: () => previewTargetIsLive(share, options, probes),
  };
}

describe('preview target activity', () => {
  it('requires a live session-owned port, without changing retained share intent', async () => {
    const f = fixture();
    expect(await f.live()).toBe(true);
    f.probes.sessionPort.mockResolvedValue(false);
    expect(await f.live()).toBe(false);
    expect(f.share.state).toBe('active');
    f.probes.sessionPort.mockResolvedValue(true);
    expect(await f.live()).toBe(true);
  });
  it('does not mistake an online offline-page connector for a live sandbox target', async () => {
    const f = fixture();
    f.inspectContainer.mockResolvedValue({ running: false });
    expect(await f.live()).toBe(false);
    expect(f.probes.sessionPort).not.toHaveBeenCalled();
  });
  it('checks legacy dev servers independently of the retained link', async () => {
    const f = fixture();
    f.share.devServerId = 'legacy';
    expect(await f.live()).toBe(true);
    vi.mocked(f.options.isDevServerRunning).mockResolvedValue(false);
    expect(await f.live()).toBe(false);
  });
  it('checks tagged managed listener ownership and port', async () => {
    const f = fixture();
    f.share.managedInstanceId = 'm';
    expect(await f.live()).toBe(true);
    vi.mocked(f.options.listListeningProcesses!).mockResolvedValue([
      { instanceId: 'other', port: 3000 },
    ] as never);
    expect(await f.live()).toBe(false);
  });
  it('requires the static folder still to exist', async () => {
    const f = fixture();
    f.share.targetKind = 'static-folder';
    f.share.staticPath = 'public';
    f.share.targetPort = null;
    expect(await f.live()).toBe(true);
    f.probes.staticDirectory.mockRejectedValue(
      new Error('invalid directory', {
        cause: Object.assign(new Error('missing'), { code: 'ENOENT' }),
      }),
    );
    expect(await f.live()).toBe(false);
    f.probes.staticDirectory.mockRejectedValue(
      Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    );
    await expect(f.live()).rejects.toThrow('permission denied');
  });
  it.each(['revoked', 'creating', 'revoking'] as const)('ignores %s intent', async (state) => {
    const f = fixture();
    f.share.state = state;
    expect(await f.live()).toBe(false);
  });
  it('ignores expiry but propagates unavailable evidence as unknown activity', async () => {
    const f = fixture();
    f.share.expiresAt = new Date('2020-01-01');
    expect(await f.live()).toBe(false);
    f.share.expiresAt = new Date('2030-01-01');
    f.probes.sessionPort.mockRejectedValue(new Error('runtime unavailable'));
    await expect(f.live()).rejects.toThrow('runtime unavailable');
  });
});

it('protects a serving preview when runtime evidence cannot be obtained', async () => {
  const f = fixture();
  f.probes.sessionPort.mockRejectedValue(new Error('runtime unavailable'));
  const activity = await observeProjectActivity({
    projectId: 'p',
    listSessions: async () => [],
    isTurnBusy: () => false,
    hasRunningDevServers: () => false,
    hasLocalPreviewShares: () => false,
    listShares: async () => [f.share],
    isShareTargetLive: () => f.live(),
  });
  expect(activityReasons(activity)).toEqual(['unknown']);
});
