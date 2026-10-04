import { describe, expect, it, vi } from 'vitest';
import { createSelectableReleaseChannelResolver } from './selectable-release-channel.js';
import { UpdaterRequestError } from './updater-status.js';

describe('selected release channel resolution', () => {
  it('changes the resolver immediately without reusing the other channel cache', async () => {
    let channel: 'stable' | 'staging' = 'stable';
    const create = vi.fn((value: 'stable' | 'staging') => ({
      resolve: async () => ({ state: 'unsupported' as const, reason: value, operation: null }),
    }));
    const resolver = createSelectableReleaseChannelResolver({
      initialChannel: 'stable',
      readChannel: async () => channel,
      create,
    });
    expect((await resolver.resolve()).state).toBe('unsupported');
    channel = 'staging';
    expect(await resolver.resolve()).toMatchObject({ reason: channel });
    channel = 'stable';
    expect(await resolver.resolve()).toMatchObject({ reason: channel });
    expect(create.mock.calls.map(([value]) => value)).toEqual(['stable', 'staging']);
  });
  it('fails closed on preference errors but supports older Updaters', async () => {
    const readChannel = vi
      .fn<() => Promise<'stable' | 'staging'>>()
      .mockRejectedValue(new Error('offline'));
    const create = vi.fn(() => ({
      resolve: async () => ({ state: 'unsupported' as const, reason: 'legacy', operation: null }),
    }));
    const resolver = createSelectableReleaseChannelResolver({
      initialChannel: 'staging',
      readChannel,
      create,
    });
    expect(await resolver.resolve()).toMatchObject({ state: 'unreachable' });
    expect(create).not.toHaveBeenCalled();
    readChannel.mockRejectedValueOnce(new UpdaterRequestError(404, 'unavailable'));
    expect(await resolver.resolve()).toMatchObject({ reason: 'legacy' });
    expect(create).toHaveBeenCalledWith('staging');
  });
});
