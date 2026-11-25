/**
 * Which kind of client sent a request, for traffic counters (ADR 0032).
 *
 * The app names itself in `x-verity-client: <kind>/<version>`. Anything else is
 * classified from its user agent. The result is a small closed set plus an
 * optional numeric version, so a client cannot widen the counter set by
 * inventing labels.
 */
type ClientKind = 'ios' | 'android' | 'watch' | 'web' | 'cli' | 'agent' | 'other';

export interface ClientIdentity {
  kind: ClientKind;
  /** A dotted release number such as `1.95.4`, or null when absent or malformed. */
  version: string | null;
}

const CLIENT_HEADER = 'x-verity-client';

const DECLARED_KINDS: ReadonlySet<string> = new Set(['ios', 'android', 'watch', 'web', 'cli']);
const VERSION = /^\d{1,4}(?:\.\d{1,4}){0,3}$/;

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function identifyClient(
  headers: Record<string, string | string[] | undefined>,
): ClientIdentity {
  const declared = headerValue(headers[CLIENT_HEADER])?.trim().toLowerCase();
  if (declared !== undefined && declared.length <= 40) {
    const [kind = '', version] = declared.split('/', 2);
    if (DECLARED_KINDS.has(kind))
      return {
        kind: kind as ClientKind,
        version: version !== undefined && VERSION.test(version) ? version : null,
      };
  }
  const agent = headerValue(headers['user-agent'])?.toLowerCase() ?? '';
  if (agent.includes('okhttp')) return { kind: 'android', version: null };
  if (agent.includes('cfnetwork') || agent.includes('darwin') || agent.includes('expo'))
    return { kind: 'ios', version: null };
  if (agent.includes('mozilla')) return { kind: 'web', version: null };
  if (agent.startsWith('curl') || agent.startsWith('verity-cli'))
    return { kind: 'cli', version: null };
  if (agent.startsWith('node') || agent.includes('undici') || agent.startsWith('claude'))
    return { kind: 'agent', version: null };
  return { kind: 'other', version: null };
}

/** The counter label: kind plus version when known, e.g. `ios/1.95.4`. */
export function clientLabel(identity: ClientIdentity): string {
  return identity.version === null ? identity.kind : `${identity.kind}/${identity.version}`;
}
