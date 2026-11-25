import * as Application from 'expo-application';
import { Platform } from 'react-native';
import { runningReleaseVersion } from './buildInfo';

/** The header the server's traffic counters read (ADR 0032). */
export const CLIENT_HEADER = 'x-verity-client';

/** Who a request is made for: the phone itself, or the watch through it. */
export type ClientDevice = 'phone' | 'watch';

/**
 * `<kind>/<version>`, e.g. `ios/1.95.4`. The server accepts only a closed set
 * of kinds and a dotted number, so this names a release, never a person or a
 * device.
 */
export function clientIdentity(
  device: ClientDevice = 'phone',
  os: string = Platform.OS,
  version: string = runningReleaseVersion(Application.nativeApplicationVersion),
): string {
  const kind = device === 'watch' ? 'watch' : os === 'android' ? 'android' : 'ios';
  return `${kind}/${version}`;
}

/**
 * Adds the client header to every request of `base`. Native only: in a
 * browser a custom header turns simple requests into CORS preflights, and the
 * server already recognises browsers by their user agent.
 */
export function withClientIdentity(base: typeof fetch, identity: string): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    // A Request carries its own headers; replacing them would drop the bearer.
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (!headers.has(CLIENT_HEADER)) headers.set(CLIENT_HEADER, identity);
    return base(input, { ...init, headers });
  }) as typeof fetch;
}
