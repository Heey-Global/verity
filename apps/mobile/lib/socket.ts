import type { StreamSocketFactory } from '@verity/mobile';

/**
 * Opens the platform `WebSocket` for the live session stream. React Native's
 * global `WebSocket` satisfies @verity/mobile's structural {@link StreamSocket}
 * (it has `addEventListener` + `close`), so this is just the injection seam the
 * headless SessionModel/SessionStream expect — tests inject a fake instead.
 */
export const createWebSocket: StreamSocketFactory = (url) => new WebSocket(url);
