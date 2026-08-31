import { isCompatible, parseServerCompat, type ServerCompat } from './compat.js';

export const RELEASE_CHANNEL_SCHEMA_VERSION = 1 as const;
export const OFFICIAL_SERVER_IMAGE = 'ghcr.io/heey-global/verity/verity-server';
export const OFFICIAL_AGENT_SEED_IMAGE = 'ghcr.io/heey-global/verity/verity-agent-seed';

export type ReleaseArchitecture = 'amd64' | 'arm64';

export interface ReleaseChannelMetadata {
  readonly schemaVersion: typeof RELEASE_CHANNEL_SCHEMA_VERSION;
  readonly channel: 'stable';
  readonly version: string;
  readonly revision: string;
  readonly architecture: ReleaseArchitecture;
  readonly serverImage: string;
  /**
   * Reserved for a future separately published seed artifact. It is `null`
   * while the seed ships inside the Server image: managed publication extracts
   * it from the exact verified `serverImage` digest, so a second mutable or
   * independently signed reference is neither needed nor accepted.
   */
  readonly agentSeedImage: string | null;
  readonly compatibility: ServerCompat;
  readonly publishedAt: string;
  readonly generation: string;
}

export function isRfc3339Timestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/**
 * The published channel document.
 *
 * The signature covers {@link payload} — the exact metadata bytes as published —
 * rather than a re-serialization of the parsed object. Verifying a re-encoded
 * document would make the signature depend on this process agreeing with the
 * publisher about key order, escaping, and number formatting, which is a
 * canonicalization hole rather than a signature check. So the parser hands the
 * original bytes back out and the verifier sees precisely what was signed.
 */
export interface SignedReleaseChannel {
  readonly metadata: ReleaseChannelMetadata;
  readonly payload: Uint8Array;
  readonly signature: { readonly kind: 'sigstore-bundle'; readonly bundle: string };
}

export type ServerUpdateAvailability =
  | { readonly state: 'unsupported'; readonly reason: string; readonly operation: null }
  | {
      readonly state: 'current';
      readonly release: ReleaseChannelMetadata;
      readonly operation: null;
    }
  | {
      readonly state: 'available';
      readonly release: ReleaseChannelMetadata;
      readonly operation: null;
    }
  | {
      readonly state: 'incompatible';
      readonly release: ReleaseChannelMetadata;
      readonly reasons: readonly string[];
      readonly operation: null;
    }
  | {
      readonly state: 'unreachable';
      readonly reason: string;
      readonly lastGood: ReleaseChannelMetadata | null;
      readonly operation: null;
    };

export interface ReleaseChannelResolver {
  resolve(): Promise<ServerUpdateAvailability>;
}

interface ReleaseChannelResolverOptions {
  readonly managed: boolean;
  readonly current: ServerCompat;
  readonly architecture: ReleaseArchitecture;
  /** Fetch the raw channel envelope. Aborting the signal must abandon the load. */
  readonly load: (signal: AbortSignal) => Promise<unknown>;
  readonly verify: (channel: SignedReleaseChannel) => Promise<boolean>;
  readonly timeoutMs?: number;
  readonly cacheTtlMs?: number;
  readonly failureCacheTtlMs?: number;
  readonly now?: () => number;
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const digestRef = (value: unknown, repository: string): value is string => {
  if (typeof value !== 'string') return false;
  const prefix = `${repository}@sha256:`;
  return value.startsWith(prefix) && /^[a-f0-9]{64}$/.test(value.slice(prefix.length));
};

/** Bounded so a hostile channel host cannot spend the Server's memory before a
 *  single signature has been checked. Both members are small documents: the
 *  metadata is a few hundred bytes, a Sigstore bundle a few kilobytes. */
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_BUNDLE_BYTES = 128 * 1024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decode strict, canonical base64. `Buffer.from(…, 'base64')` silently ignores
 * invalid characters and truncated groups, so a lenient decode would accept
 * several distinct strings for the same bytes. Round-tripping the result rejects
 * every non-canonical spelling instead.
 */
function decodeBase64(value: unknown, maxBytes: number): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return null;
  if (!BASE64.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) return null;
  return bytes.toString('base64') === value ? bytes : null;
}

function parseVersion(value: unknown): readonly [number, number, number] | null {
  if (typeof value !== 'string') return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (match === null) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger)
    ? (parts as unknown as readonly [number, number, number])
    : null;
}

function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return null;
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Parse the published envelope.
 *
 * The envelope itself carries nothing that is interpreted before the signature
 * is checked: no version, no channel name, no hints. Everything the Server acts
 * on lives in the signed payload, so a channel host that rewrites the envelope
 * can only make verification fail, never steer it.
 */
export function parseSignedReleaseChannel(value: unknown): SignedReleaseChannel | null {
  if (!object(value) || !exactKeys(value, ['payload', 'signature'])) return null;
  const payload = decodeBase64(value.payload, MAX_PAYLOAD_BYTES);
  if (payload === null) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload.toString('utf8'));
  } catch {
    return null;
  }
  const parsed = parseReleaseChannelMetadata(decoded);
  if (parsed === null) return null;
  const signature = value.signature;
  if (
    !object(signature) ||
    !exactKeys(signature, ['kind', 'bundle']) ||
    signature.kind !== 'sigstore-bundle' ||
    decodeBase64(signature.bundle, MAX_BUNDLE_BYTES) === null
  )
    return null;
  return {
    metadata: parsed,
    payload: new Uint8Array(payload),
    signature: { kind: 'sigstore-bundle', bundle: signature.bundle as string },
  };
}

/** Strict parser for the signed metadata document. */
export function parseReleaseChannelMetadata(metadata: unknown): ReleaseChannelMetadata | null {
  if (
    !object(metadata) ||
    !exactKeys(metadata, [
      'schemaVersion',
      'channel',
      'version',
      'revision',
      'architecture',
      'serverImage',
      'agentSeedImage',
      'compatibility',
      'publishedAt',
      'generation',
    ]) ||
    metadata.schemaVersion !== RELEASE_CHANNEL_SCHEMA_VERSION ||
    metadata.channel !== 'stable' ||
    parseVersion(metadata.version) === null ||
    typeof metadata.revision !== 'string' ||
    !/^[a-f0-9]{40}$/.test(metadata.revision) ||
    (metadata.architecture !== 'amd64' && metadata.architecture !== 'arm64') ||
    !digestRef(metadata.serverImage, OFFICIAL_SERVER_IMAGE) ||
    (metadata.agentSeedImage !== null &&
      !digestRef(metadata.agentSeedImage, OFFICIAL_AGENT_SEED_IMAGE)) ||
    typeof metadata.publishedAt !== 'string' ||
    !isRfc3339Timestamp(metadata.publishedAt) ||
    typeof metadata.generation !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(metadata.generation)
  )
    return null;
  const compatibility = parseServerCompat(metadata.compatibility);
  if (compatibility === null || compatibility.serverVersion !== metadata.version) return null;
  return {
    schemaVersion: 1,
    channel: 'stable',
    version: metadata.version,
    revision: metadata.revision,
    architecture: metadata.architecture,
    serverImage: metadata.serverImage,
    agentSeedImage: metadata.agentSeedImage,
    compatibility,
    publishedAt: metadata.publishedAt,
    generation: metadata.generation,
  };
}

export function createReleaseChannelResolver(
  options: ReleaseChannelResolverOptions,
): ReleaseChannelResolver {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const cacheTtlMs = options.cacheTtlMs ?? 5 * 60_000;
  // Outages are often transient (a channel may be published while this process
  // is already running, or the first cold Sigstore/TUF bootstrap may just miss
  // the lookup deadline). Do not turn one miss into five minutes of false
  // unavailability; successful verified releases can keep the longer cache.
  const failureCacheTtlMs = options.failureCacheTtlMs ?? 5_000;
  const now = options.now ?? Date.now;
  let cached: { at: number; availability: ServerUpdateAvailability } | undefined;
  let lastGood: ReleaseChannelMetadata | null = null;
  let inFlight: Promise<ServerUpdateAvailability> | undefined;

  const lookup = async (): Promise<ServerUpdateAvailability> => {
    if (!options.managed) {
      return { state: 'unsupported', reason: 'deployment is not managed', operation: null };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const timedOut = new Promise<never>((_resolve, reject) => {
      const rejectTimeout = () =>
        reject(new Error(`release channel lookup timed out after ${timeoutMs}ms`));
      if (controller.signal.aborted) rejectTimeout();
      else controller.signal.addEventListener('abort', rejectTimeout, { once: true });
    });
    try {
      return await Promise.race([
        (async (): Promise<ServerUpdateAvailability> => {
          const channel = parseSignedReleaseChannel(await options.load(controller.signal));
          if (channel === null) throw new Error('release channel metadata is invalid');
          if (!(await options.verify(channel))) {
            throw new Error('release channel signature is invalid');
          }
          if (controller.signal.aborted) {
            throw new Error(`release channel lookup timed out after ${timeoutMs}ms`);
          }
          if (lastGood !== null) {
            const monotonic = compareVersions(channel.metadata.version, lastGood.version);
            if (monotonic === null || monotonic < 0)
              throw new Error(
                'release channel metadata rolled back below the last verified release',
              );
            if (
              monotonic === 0 &&
              (channel.metadata.serverImage !== lastGood.serverImage ||
                channel.metadata.revision !== lastGood.revision)
            )
              throw new Error('release channel metadata equivocated at an existing version');
          }
          if (channel.metadata.architecture !== options.architecture) {
            lastGood = channel.metadata;
            return {
              state: 'incompatible',
              release: channel.metadata,
              reasons: [
                `release architecture ${channel.metadata.architecture} does not match host architecture ${options.architecture}`,
              ],
              operation: null,
            };
          }
          const comparison = compareVersions(
            channel.metadata.version,
            options.current.serverVersion,
          );
          if (comparison === null)
            throw new Error('running Server version is not a stable release');
          if (comparison <= 0) {
            lastGood = channel.metadata;
            return { state: 'current', release: channel.metadata, operation: null };
          }
          const compatibility = isCompatible(options.current, channel.metadata.compatibility);
          if (!compatibility.compatible) {
            lastGood = channel.metadata;
            return {
              state: 'incompatible',
              release: channel.metadata,
              reasons: compatibility.reasons,
              operation: null,
            };
          }
          lastGood = channel.metadata;
          return { state: 'available', release: channel.metadata, operation: null };
        })(),
        timedOut,
      ]);
    } catch (error) {
      return {
        state: 'unreachable',
        reason: error instanceof Error ? error.message : String(error),
        lastGood,
        operation: null,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async resolve() {
      const ttl =
        cached?.availability.state === 'unreachable'
          ? Math.min(failureCacheTtlMs, cacheTtlMs)
          : cacheTtlMs;
      if (cached !== undefined && now() - cached.at < ttl) return cached.availability;
      inFlight ??= lookup().then((availability) => {
        cached = { at: now(), availability };
        return availability;
      });
      try {
        return await inFlight;
      } finally {
        inFlight = undefined;
      }
    },
  };
}
