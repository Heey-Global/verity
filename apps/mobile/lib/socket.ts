import type { StreamSocketFactory } from '@verity/mobile';
import { createPinnedWebSocket } from './pinnedTransport';
import { getServerProfile } from './serverProfile';

/**
 * Opens the platform `WebSocket` for the live session stream. React Native's
 * global `WebSocket` satisfies @verity/mobile's structural {@link StreamSocket}
 * (it has `addEventListener` + `close`), so this is just the injection seam the
 * headless SessionModel/SessionStream expect — tests inject a fake instead.
 */
export const createWebSocket: StreamSocketFactory = (url, protocols) => {
  const endpoint = getServerProfile()?.endpoints.find(({ url: endpointUrl }) => {
    const socketOrigin = new URL(url).origin.replace(/^ws/, 'http');
    return endpointUrl === socketOrigin;
  });
  return endpoint?.transport === 'direct'
    ? createPinnedWebSocket(url, endpoint.tlsPin!, protocols)
    : new WebSocket(url, protocols);
};
