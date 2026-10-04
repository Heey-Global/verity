import type { ReleaseChannelName, ReleaseChannelResolver } from './release-channel.js';
import { UpdaterRequestError } from './updater-status.js';

/** Each channel has its own signed-metadata cache; a failed preference read never selects Stable. */
export function createSelectableReleaseChannelResolver(options: {
  initialChannel: ReleaseChannelName;
  readChannel?: (() => Promise<ReleaseChannelName>) | undefined;
  create: (channel: ReleaseChannelName) => ReleaseChannelResolver;
}): ReleaseChannelResolver {
  const resolvers = new Map<ReleaseChannelName, ReleaseChannelResolver>();
  return {
    async resolve() {
      let channel = options.initialChannel;
      if (options.readChannel) {
        try {
          channel = await options.readChannel();
        } catch (error) {
          // Only an older Updater's absent endpoint permits the legacy environment fallback.
          if (!(error instanceof UpdaterRequestError && error.status === 404))
            return {
              state: 'unreachable',
              reason: 'update channel is unavailable',
              lastGood: null,
              operation: null,
            };
        }
      }
      let resolver = resolvers.get(channel);
      if (!resolver) {
        resolver = options.create(channel);
        resolvers.set(channel, resolver);
      }
      return resolver.resolve();
    },
  };
}
