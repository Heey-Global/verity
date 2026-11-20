import { ConnectionMonitor } from '@verity/mobile';

/**
 * The one connection state of the app. Every client built by `createVerityClient`
 * reports into it, so a server update or a lost route is shown once — in the
 * header's connection bar — rather than by every screen that happened to poll.
 * `lib/client.ts` supplies the check it runs while the server is away.
 */
export const serverConnection = new ConnectionMonitor();
