import { beginClientActivity } from './sessionSwitchTiming';
import type { LiveSocket, LiveSocketFactory } from '@verity/mobile';
import { createPinnedWebSocket } from './pinnedTransport';
import { getServerProfile } from './serverProfile';
import { createDemoSocket, isDemoUrl } from './demoTransport';

/**
 * Opens the platform `WebSocket` for the live connection. React Native's global
 * `WebSocket` satisfies @verity/mobile's structural {@link LiveSocket}
 * (`addEventListener`, `send`, `close`), so this is just the injection seam the
 * headless LiveConnection expects — tests inject a fake instead.
 */
export const createWebSocket: LiveSocketFactory = (url, protocols) => {
  if (isDemoUrl(url)) return createDemoSocket(url, protocols);
  const endpoint = getServerProfile()?.endpoints.find(({ url: endpointUrl }) => {
    const socketOrigin = new URL(url).origin.replace(/^ws/, 'http');
    return endpointUrl === socketOrigin;
  });
  const socket =
    endpoint?.transport === 'direct'
      ? createPinnedWebSocket(url, endpoint.tlsPin!, protocols, true)
      : new WebSocket(url, protocols);
  return measureSocketActivity(socket);
};

/** Includes synchronous decoding and all listeners invoked by the connection. */
export function measureSocketActivity(socket: LiveSocket): LiveSocket {
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    addEventListener: (type, listener) =>
      socket.addEventListener(type, (event) => {
        const finish = type === 'message' ? beginClientActivity('socket-message') : () => undefined;
        try {
          listener(event);
        } finally {
          finish();
        }
      }),
  };
}
