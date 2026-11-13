import type { ServerConnectionState } from '@verity/mobile';

import type { ConnectionView } from '../hooks/useServerConnection';

/** "1:24" — how long the server has been away. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** "Retrying in 8 s", or "In 8 s" where the row already says what is next. */
export function nextAttemptText(state: ServerConnectionState, now: number, short = false): string {
  if (state.kind === 'connected') return '';
  if (state.nextAttemptAt === undefined) return 'Checking…';
  const seconds = Math.max(1, Math.ceil((state.nextAttemptAt - now) / 1000));
  return `${short ? 'In' : 'Retrying in'} ${String(seconds)} s`;
}

/** Title and subtitle of the header's connection bar; `null` when it is hidden. */
export function connectionBarText(
  view: ConnectionView,
  state: ServerConnectionState,
  now: number,
): { title: string; subtitle: string } | null {
  switch (view) {
    case 'connected':
      return null;
    case 'recovered':
      return { title: 'Connected', subtitle: 'Back online · refreshing your sessions' };
    case 'maintenance':
      return {
        title: 'Server is updating',
        subtitle: `Reconnecting automatically · ${formatElapsed(now - (state.kind === 'connected' ? now : state.since))}`,
      };
    case 'unreachable':
      return { title: 'Can’t reach your server', subtitle: nextAttemptText(state, now) };
  }
}

/**
 * The routes a failure names, in words. Remote Control failures carry the
 * Uplink stage; a direct failure says so, and a plain transport error is the
 * direct route by definition. Raw output stays in the technical details.
 */
export function failedRoutes(details: string): { remote: boolean; direct: boolean } {
  const remote = /Uplink|Remote (?:admission|Core probe|tunnel)/u.test(details);
  const direct = /[Dd]irect Core requests? failed/u.test(details) || !remote;
  return { remote, direct };
}

/** "verity.build" from the saved server URL. */
export function serverHost(baseUrl: string | null): string {
  if (baseUrl === null) return 'Your server';
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
