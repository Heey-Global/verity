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
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      sandboxUpdates,
      containerLiveness: {
        start: () => stopFollowing,
        following: () => following,
        onContainerChange: () => () => undefined,
      },
    });
    await server.ready();
    expect(trustInspections).toHaveBeenCalledTimes(1);
    const [source] = trustInspections.mock.calls[0] as unknown as [{ following(): boolean }];
    expect(source.following()).toBe(false);
    following = true;
    expect(source.following()).toBe(true);
    await server.close();
    expect(stopTrusting).toHaveBeenCalled();
    expect(stopFollowing).toHaveBeenCalled();
  });
});
