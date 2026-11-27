import { describe, expect, it, vi } from 'vitest';
import type { SandboxUpdateChecker } from './sandbox-updates.js';
import { bus, conductor, ctx } from './server-fixture.test-helper.js';
import { buildServer } from './server.js';

describe('installProjects', () => {
  // The checker keeps inspecting every running sandbox on each overview read
  // unless the server hands it the follower; nothing else would notice.
  it('lets the update checker trust its inspections while the server follows Docker', async () => {
    const stopTrusting = vi.fn();
    const trustInspections = vi.fn(() => stopTrusting);
    const sandboxUpdates = {
      status: vi.fn(),
      statusAll: vi.fn(async () => new Map()),
      trustInspections,
    } as unknown as SandboxUpdateChecker;
    const stopFollowing = vi.fn(async () => undefined);
    let following = false;
    const heard: ((projectId: string | undefined) => void)[] = [];
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      sandboxUpdates,
      containerLiveness: {
        start: () => stopFollowing,
        following: () => following,
        onContainerChange: (listener) => {
          heard.push(listener);
          return () => undefined;
        },
      },
    });
    await server.ready();
    expect(trustInspections).toHaveBeenCalledTimes(1);
    const [source] = trustInspections.mock.calls[0] as unknown as [
      {
        following: () => boolean;
        onContainerChange: (listener: (projectId: string | undefined) => void) => () => void;
      },
    ];
    expect(source.following()).toBe(false);
    following = true;
    expect(source.following()).toBe(true);
    // A change the follower reports reaches what the checker listens with.
    const checkerHeard = vi.fn();
    source.onContainerChange(checkerHeard);
    heard.forEach((listener) => listener('p1'));
    expect(checkerHeard).toHaveBeenCalledWith('p1');
    await server.close();
    expect(stopTrusting).toHaveBeenCalled();
    expect(stopFollowing).toHaveBeenCalled();
  });
});
