export function parseWwwAuthenticate(header: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const match of header.matchAll(/([a-zA-Z]+)="([^"]*)"/g)) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) params[key] = value;
  }
  return params;
}

export function splitImageTagRef(ref: string): {
  registry: string;
  repo: string;
  reference: string;
} {
  const firstSlash = ref.indexOf('/');
  const registry = ref.slice(0, firstSlash);
  const rest = ref.slice(firstSlash + 1);
  const colon = rest.lastIndexOf(':');
  if (firstSlash <= 0 || colon <= 0 || rest.includes('@')) {
    throw new Error(`invalid tagged OCI ref: ${ref}`);
  }
  return { registry, repo: rest.slice(0, colon), reference: rest.slice(colon + 1) };
}

/**
 * How long any one registry resolution may take, end to end.
 *
 * A manifest walk is three sequential reads, so the bound belongs to the walk
 * rather than to each leg: one `AbortSignal.timeout` is threaded through all of
 * them. Matches the bound the preview-connector resolver already uses at
 * startup — an unbounded registry read is what turned an overview poll into a
 * 30-second request.
 */
export const REGISTRY_RESOLVE_TIMEOUT_MS = 10_000;

/**
 * Anonymous pull tokens, keyed by `registry/repo`.
 *
 * Without this every `registryFetch` is three round trips — 401, token
 * exchange, retry — because the token is thrown away as soon as the read
 * completes. The walk in `resolvePublicOciImageVersion` makes three such reads,
 * so one version resolution cost nine requests to ghcr.io where three suffice.
 *
 * Only anonymous pull scopes land here, so an entry grants nothing a fresh
 * challenge would not. A cached token the registry rejects is dropped and
 * re-minted (see below), which is also what makes an expiry miss self-healing.
 */
const registryTokens = new Map<string, { token: string; expiresAt: number }>();

/** Drop every cached pull token. Exported for tests, which must not inherit one. */
export function clearRegistryTokenCache(): void {
  registryTokens.clear();
}

function cachedRegistryToken(key: string): string | undefined {
  const cached = registryTokens.get(key);
  if (cached === undefined) return undefined;
  if (cached.expiresAt <= Date.now()) {
    registryTokens.delete(key);
    return undefined;
  }
  return cached.token;
}

function registryTokenLifetimeMs(body: { expires_in?: unknown }): number {
  const seconds =
    typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) ? body.expires_in : 60;
  // Expire the entry a little early: a token that lapses in flight costs the
  // 401 retry this cache exists to avoid, and the margin is far cheaper than
  // the round trip it saves. The cap keeps a generously long registry-issued
  // lifetime from pinning one token for hours — five minutes is already past
  // the point where re-minting costs anything measurable.
  return Math.max(0, Math.min(seconds, 300) - 10) * 1000;
}

/**
 * Replace whatever credential the caller brought with the bearer we hold.
 *
 * Spreading ours over theirs is not enough: header names are case-insensitive,
 * so a caller spelling it `Authorization` leaves both keys in the record, and a
 * record init appends rather than replaces — the registry would receive one
 * `authorization: Basic …, Bearer …`, which is not a credential it accepts. The
 * caller's own credential is the one the 401 just refused, so dropping it is
 * also the right answer on the merits.
 */
function withBearer(headers: Record<string, string>, token: string): Record<string, string> {
  const kept = Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization');
  return { ...Object.fromEntries(kept), authorization: `Bearer ${token}` };
}

/**
 * One anonymous read against an OCI distribution endpoint, performing the
 * `www-authenticate` pull-token dance when the registry asks for it.
 *
 * Exported so other readers of public Verity artifacts (the release channel
 * document, ADR 0008 D4) share this one implementation of the token exchange
 * rather than growing a second, subtly different one.
 */
export async function registryFetch(
  registry: string,
  repo: string,
  path: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
  trustedTokenHosts: readonly string[] = [],
): Promise<Response> {
  const init: RequestInit = signal === undefined ? {} : { signal };
  const url = `https://${registry}/v2/${repo}/${path}`;
  const tokenKey = `${registry}/${repo}`;
  // A caller that brought its own credential keeps it — the cache only ever
  // fills in for the anonymous case it was minted for. HTTP header names are
  // case-insensitive, so a caller spelling it `Authorization` must not be read
  // as anonymous: that would file its credentialed token under the shared key.
  const anonymous = !Object.keys(headers).some((name) => name.toLowerCase() === 'authorization');
  const reuse = anonymous ? cachedRegistryToken(tokenKey) : undefined;
  let response = await fetch(url, {
    headers: reuse === undefined ? headers : withBearer(headers, reuse),
    ...init,
  });
  // A cached token the registry no longer accepts is worse than none — drop it
  // so the next read mints a fresh one instead of replaying the stale bearer
  // until the entry lapses. Only what was actually replayed may be evicted: an
  // anonymous first read that is merely challenged says nothing about a token a
  // concurrent read has just put there, and a refused credentialed request says
  // nothing about the shared anonymous one.
  //
  // 403 counts as a refusal too. The spec-conformant answer to a lapsed bearer
  // is 401, but registries that answer 403 would otherwise keep failing every
  // read for the entry's remaining lifetime. It is not retried here: a 403 need
  // not carry a challenge, and a genuinely forbidden repo should surface as
  // that 403 rather than as a missing-challenge error.
  // Matched by value, not just by key: between the read above and here a
  // concurrent caller may have minted and stored a fresh token under the same
  // key, and deleting that one would make the next reader pay a walk to learn
  // what it already knew.
  if (
    reuse !== undefined &&
    (response.status === 401 || response.status === 403) &&
    registryTokens.get(tokenKey)?.token === reuse
  ) {
    registryTokens.delete(tokenKey);
  }
  if (response.status !== 401) return response;

  const challenge = response.headers.get('www-authenticate');
  if (challenge === null)
    throw new Error(`registry auth challenge missing for ${registry}/${repo}`);
  const params = parseWwwAuthenticate(challenge);
  if (params.realm === undefined)
    throw new Error(`registry auth realm missing for ${registry}/${repo}`);
  const tokenUrl = new URL(params.realm);
  const registryHost = registry.split(':', 1)[0]!.toLowerCase();
  const tokenHost = tokenUrl.hostname.toLowerCase();
  const allowedTokenHosts = new Set([
    registryHost,
    ...trustedTokenHosts.map((host) => host.toLowerCase()),
  ]);
  if (
    tokenUrl.protocol !== 'https:' ||
    tokenUrl.username !== '' ||
    tokenUrl.password !== '' ||
    tokenUrl.port !== '' ||
    !allowedTokenHosts.has(tokenHost)
  ) {
    throw new Error(`registry auth realm is not trusted for ${registry}/${repo}`);
  }
  if (params.service !== undefined) tokenUrl.searchParams.set('service', params.service);
  tokenUrl.searchParams.set('scope', params.scope ?? `repository:${repo}:pull`);
  const tokenResponse = await fetch(tokenUrl, init);
  if (!tokenResponse.ok) {
    throw new Error(
      `registry token request failed for ${registry}/${repo}: HTTP ${tokenResponse.status}`,
    );
  }
  const tokenBody = (await tokenResponse.json()) as {
    token?: unknown;
    access_token?: unknown;
    expires_in?: unknown;
  };
  const token =
    typeof tokenBody.token === 'string'
      ? tokenBody.token
      : typeof tokenBody.access_token === 'string'
        ? tokenBody.access_token
        : undefined;
  if (token === undefined || token.length === 0) {
    throw new Error(`registry token response had no token for ${registry}/${repo}`);
  }
  // Dated from issue, not from when the retry happens to finish: the early
  // margin exists to cover the next read, and a slow blob would otherwise eat it.
  const expiresAt = Date.now() + registryTokenLifetimeMs(tokenBody);
  response = await fetch(url, { headers: withBearer(headers, token), ...init });
  // Cache only what an anonymous caller could have minted itself: a token
  // derived from a caller's own credential may carry a wider scope, and this
  // cache is process-wide, so every later anonymous read would inherit it.
  // Cached after the retry, not before — a token the registry then refuses is
  // one the next read would have to discover and re-mint at its own cost. 403
  // is a refusal here for the same reason it is one above: caching it would
  // hand the next read a token this one already knows is bad.
  if (anonymous && response.status !== 401 && response.status !== 403 && expiresAt > Date.now()) {
    registryTokens.set(tokenKey, { token, expiresAt });
  }
  return response;
}

export async function resolvePublicOciTagDigest(
  ref: string,
  signal?: AbortSignal,
): Promise<string> {
  const { registry, repo, reference } = splitImageTagRef(ref);
  const accept = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
  ].join(', ');
  const response = await registryFetch(
    registry,
    repo,
    `manifests/${reference}`,
    { accept },
    signal,
  );
  if (!response.ok)
    throw new Error(`registry manifest request failed for ${ref}: HTTP ${response.status}`);
  const digest = response.headers.get('docker-content-digest');
  if (digest === null || !digest.startsWith('sha256:')) {
    throw new Error(`registry manifest response had no digest for ${ref}`);
  }
  return `${registry}/${repo}@${digest}`;
}

/** Bound optional startup-time registry discovery. The resolver may be backed by
 * a network stack that ignores cancellation, so callers must not await it
 * indefinitely before opening the local control plane. */
export function resolveWithTimeout<T>(resolver: () => Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error('registry resolution timeout must be positive'));
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('registry resolution timed out')), timeoutMs);
    void resolver().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(
          error instanceof Error
            ? error
            : new Error('registry resolution failed', { cause: error }),
        );
      },
    );
  });
}

export async function resolvePublicOciImageVersion(
  ref: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const { registry, repo, reference } = splitImageReference(ref);
  const accept = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
  ].join(', ');
  let response = await registryFetch(registry, repo, `manifests/${reference}`, { accept }, signal);
  if (!response.ok)
    throw new Error(`registry manifest request failed for ${ref}: HTTP ${response.status}`);
  let manifest = (await response.json()) as OciManifest;
  if (Array.isArray(manifest.manifests)) {
    const imageManifest =
      manifest.manifests.find(
        (entry) => entry.platform?.os === 'linux' && entry.platform.architecture === 'amd64',
      ) ?? manifest.manifests[0];
    if (imageManifest === undefined) throw new Error(`registry image index was empty for ${ref}`);
    response = await registryFetch(
      registry,
      repo,
      `manifests/${imageManifest.digest}`,
      { accept },
      signal,
    );
    if (!response.ok)
      throw new Error(`registry image manifest request failed for ${ref}: HTTP ${response.status}`);
    manifest = (await response.json()) as OciManifest;
  }
  if (manifest.config?.digest === undefined)
    throw new Error(`registry image manifest had no config for ${ref}`);
  response = await registryFetch(registry, repo, `blobs/${manifest.config.digest}`, {}, signal);
  if (!response.ok)
    throw new Error(`registry image config request failed for ${ref}: HTTP ${response.status}`);
  const config = (await response.json()) as { config?: { Labels?: Record<string, unknown> } };
  const version = config.config?.Labels?.['org.opencontainers.image.version'];
  return typeof version === 'string' && version.trim().length > 0 ? version.trim() : undefined;
}

/**
 * The image version behind a ref, cached per ref and resolved at most once at a
 * time.
 *
 * The sandbox update checker asks for this while serializing a project, so the
 * callers are the same high-frequency pollers `createPublishedDefaultResolver`
 * already caches for — the version resolver was simply never given the same
 * treatment, and each miss walks three manifests against ghcr.io. Caching it
 * here rather than at the call site keeps every caller on one answer.
 *
 * The TTL matches the sibling resolver's 5 minutes: the two are read on the same
 * poll, so the shorter-lived entry is the one that decides how often the
 * registry is touched at all. On the default wiring it could be far longer — the
 * ref is then a digest, and a version label keyed by an immutable digest is
 * itself immutable — but `VERITY_DEFAULT_PROJECT_IMAGE` may name a tag, whose
 * content can move under it.
 *
 * A failure is cached too, briefly. Otherwise a registry outage turns every
 * poll into a fresh failed walk, which is the load pattern this exists to stop.
 * As in the sibling resolver, a ref that resolved once keeps serving that answer
 * through a later failure: a blip must not blank a version the overview was
 * already showing. For a digest that answer stays right indefinitely; for a tag
 * an outage can hold a version past its truth, which is still the better of the
 * two, since the alternative is showing none at all.
 */
export function createCachedImageVersionResolver(
  options: {
    resolve?: (ref: string, signal?: AbortSignal) => Promise<string | undefined>;
    ttlMs?: number;
    failureTtlMs?: number;
    timeoutMs?: number;
  } = {},
): (imageRef: string) => Promise<string | undefined> {
  const {
    resolve = resolvePublicOciImageVersion,
    ttlMs = 5 * 60 * 1000,
    failureTtlMs = 60_000,
    timeoutMs = REGISTRY_RESOLVE_TIMEOUT_MS,
  } = options;
  const cache = new Map<string, { result: Promise<string | undefined>; expiresAt: number }>();
  const lastResolved = new Map<string, string>();
  return async (imageRef) => {
    const cached = cache.get(imageRef);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.result;
    const walk = resolve(imageRef, AbortSignal.timeout(timeoutMs));
    let timeout: NodeJS.Timeout | undefined;
    let timedOut = false;
    const bounded = Promise.race([
      walk,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          reject(new Error('OCI version resolution timed out'));
        }, timeoutMs);
        timeout.unref();
      }),
    ]).finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
    });
    const result = bounded.then(
      (version) => {
        // Only a real version is worth falling back to. Remembering "this ref
        // has no version label" would make every later failure look like that
        // same answer, and an outage on the no-label path would go unreported.
        if (version !== undefined) lastResolved.set(imageRef, version);
        return version;
      },
      (error: unknown) => {
        const last = lastResolved.get(imageRef);
        if (last === undefined) throw error;
        return last;
      },
    );
    // Concurrent callers join this walk instead of each starting their own —
    // the fan-out across a project list is exactly that shape. The explicit race
    // also bounds resolvers that ignore their AbortSignal.
    const entry = { result, expiresAt: Date.now() + timeoutMs };
    cache.set(imageRef, entry);
    try {
      await bounded;
      entry.expiresAt = Date.now() + ttlMs;
    } catch {
      // Short TTL even when a last-good answer covers the failure: the point is
      // to retry soon, just not on every poll.
      entry.expiresAt = timedOut ? Date.now() : Date.now() + failureTtlMs;
    }
    return result;
  };
}

interface OciManifest {
  config?: { digest?: string | undefined } | undefined;
  manifests?:
    | Array<{
        digest: string;
        platform?: { architecture?: string | undefined; os?: string | undefined } | undefined;
      }>
    | undefined;
}

function splitImageReference(ref: string): {
  registry: string;
  repo: string;
  reference: string;
} {
  const digestSeparator = ref.lastIndexOf('@');
  if (digestSeparator !== -1) {
    const image = ref.slice(0, digestSeparator);
    const firstSlash = image.indexOf('/');
    const reference = ref.slice(digestSeparator + 1);
    if (firstSlash <= 0 || reference.length === 0) throw new Error(`invalid OCI ref: ${ref}`);
    return {
      registry: image.slice(0, firstSlash),
      repo: image.slice(firstSlash + 1),
      reference,
    };
  }
  return splitImageTagRef(ref);
}

export function selectLatestSemverTag(tags: readonly string[]): string | undefined {
  const semver = tags
    .map((tag) => {
      const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(tag);
      if (match === null) return undefined;
      const major = Number(match[1]);
      const minor = Number(match[2]);
      const patch = Number(match[3]);
      return { tag, major, minor, patch };
    })
    .filter(
      (tag): tag is { tag: string; major: number; minor: number; patch: number } =>
        tag !== undefined,
    );
  semver.sort((a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch);
  return semver.at(-1)?.tag;
}

export async function resolvePublicOciLatestSemverTag(
  ref: string,
  signal?: AbortSignal,
): Promise<string> {
  return resolvePublicOciLatestTag(ref, selectLatestSemverTag, 'semver', signal);
}

export async function resolvePublicOciLatestSemverDigest(
  ref: string,
  signal?: AbortSignal,
): Promise<string> {
  return resolvePublicOciTagDigest(await resolvePublicOciLatestSemverTag(ref, signal), signal);
}

/**
 * The sibling artifact this Server release was published alongside — or
 * `undefined` when there is no release version to name one with.
 *
 * `release.yml` publishes verity-server, verity-sandbox and the
 * verity-sandbox-toolkit Feature from ONE release-please version and bakes it
 * into the Server image as `VERITY_SERVER_VERSION`, so a deployed Server can
 * name the artifacts it was built with instead of resolving `:latest`. That
 * distinction is load-bearing rather than cosmetic: the Server attests every
 * Sandbox against the toolkit BAKED INTO ITS OWN IMAGE, so an artifact resolved
 * from `:latest` is by construction the one thing it cannot vouch for — between
 * a publish and the Server upgrade that follows it, `:latest` is a strictly
 * newer toolkit than the trust root, and every Sandbox built on it fails the
 * runner-boundary check.
 *
 * Only an exact `major.minor.patch` counts. Dev and PR builds never run
 * semantic-release, so they carry the `0.0.0-dev` sentinel (or nothing at all)
 * and keep the published-latest behavior — there is no release artifact under
 * that name to pin to, and inventing one would resolve to nothing.
 *
 * `tagPrefix` has to be stated per repository because the two artifacts really
 * are tagged differently, and guessing produces a ref that resolves to nothing:
 * `release.yml` pushes the sandbox IMAGE as `v<version>` (plus `sha-…` and
 * `latest` — there is no bare semver tag), while the toolkit FEATURE is
 * published by `devcontainers/action` under bare semver tags, its `v`-prefixed
 * tag being a visible-version index rather than a resolvable Feature manifest
 * (see `normalizeFeatureTag`).
 */
export function releasePinnedRef(
  repo: string,
  tagPrefix: '' | 'v',
  serverVersion: string | undefined = process.env.VERITY_SERVER_VERSION,
): string | undefined {
  const version = serverVersion?.trim() ?? '';
  return /^\d+\.\d+\.\d+$/.test(version) ? `${repo}:${tagPrefix}${version}` : undefined;
}

async function resolvePublicOciLatestTag(
  ref: string,
  select: (tags: readonly string[]) => string | undefined,
  label: string,
  signal?: AbortSignal,
): Promise<string> {
  const { registry, repo } = splitImageTagRef(ref);
  const tags: string[] = [];
  let path: string | undefined = 'tags/list';
  while (path !== undefined) {
    const response = await registryFetch(registry, repo, path, {}, signal);
    if (!response.ok)
      throw new Error(`registry tags request failed for ${ref}: HTTP ${response.status}`);
    const body = (await response.json()) as { tags?: unknown };
    if (Array.isArray(body.tags)) {
      tags.push(...body.tags.filter((tag): tag is string => typeof tag === 'string'));
    }
    path = nextRegistryTagsPath(response.headers.get('link'), repo);
  }
  const latest = select(tags);
  if (latest === undefined)
    throw new Error(`registry tags response had no ${label} tags for ${ref}`);
  return `${registry}/${repo}:${latest}`;
}

function nextRegistryTagsPath(link: string | null, repo: string): string | undefined {
  if (link === null) return undefined;
  const prefix = `/v2/${repo}/`;
  for (const entry of link.split(',')) {
    const [target, ...params] = entry.split(';').map((part) => part.trim());
    if (!params.some((part) => part.toLowerCase() === 'rel="next"')) continue;
    if (target === undefined || !target.startsWith('<') || !target.endsWith('>')) continue;
    const raw = target.slice(1, -1);
    const path =
      raw.startsWith('https://') || raw.startsWith('http://')
        ? new URL(raw).pathname + new URL(raw).search
        : raw;
    return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
  }
  return undefined;
}

export function createPublishedDefaultResolver(
  explicit: string | undefined,
  latestTag: string,
  fallback: string,
  label: string,
  resolve: (ref: string, signal?: AbortSignal) => Promise<string> = resolvePublicOciTagDigest,
  ttlMs = 5 * 60 * 1000,
): (forceRefresh?: boolean) => Promise<string> {
  const trimmed = explicit?.trim();
  if (trimmed !== undefined && trimmed.length > 0) return () => Promise.resolve(trimmed);
  let cached: { value: string; expiresAt: number } | undefined;
  // The last value the REGISTRY actually gave us, kept without an expiry and
  // apart from `cached` — which may hold the fallback. A resolved value is an
  // immutable digest for the right artifact; the fallback is at best a tag,
  // whose content can move under it. So when a refresh fails after the cache
  // has expired, the previous digest is strictly the better answer, however
  // old: it is what this deployment was already handing out a moment ago.
  let lastResolved: string | undefined;
  return async (forceRefresh = false) => {
    const now = Date.now();
    // High-frequency callers (the update-status poll, every project serialize)
    // read the 5-minute cache so a few sessions don't hammer GHCR. `forceRefresh`
    // bypasses that read for the one-shot provision/recreate path, so a brand-new
    // container is pinned to the CURRENT digest instead of a stale cached one —
    // otherwise the container's creation-time ref diverges from what the checker
    // later resolves and a freshly created project shows a phantom "update
    // available". The freshly resolved value is written back to the shared cache
    // so the immediately-following status checks agree.
    if (!forceRefresh && cached !== undefined && cached.expiresAt > now) return cached.value;
    try {
      // Bounded: this is awaited on the request path (every project serialize),
      // so a registry that accepts the connection and then stalls must fail
      // rather than hold the response open.
      const value = await resolve(latestTag, AbortSignal.timeout(REGISTRY_RESOLVE_TIMEOUT_MS));
      cached = { value, expiresAt: now + ttlMs };
      lastResolved = value;
      return value;
    } catch (error) {
      // A refresh that fails mid-flight must not regress a still-valid cached
      // digest down to the hardcoded fallback — that would itself flag a phantom
      // update once the registry recovers. Prefer the live cache when present.
      if (cached !== undefined && cached.expiresAt > now) return cached.value;
      // Past that, an EXPIRED resolved digest still beats the fallback: it names
      // one immutable artifact this deployment already selected, where the
      // fallback may be a tag whose content can move. Re-cached briefly so a
      // registry outage does not turn every call into a failed round trip, and
      // re-warned on each retry so the outage stays visible.
      if (lastResolved !== undefined) {
        console.warn(
          `verity: could not resolve ${label} ${latestTag}; keeping the last resolved ${lastResolved}: ${String(error)}`,
        );
        cached = { value: lastResolved, expiresAt: now + Math.min(ttlMs, 60_000) };
        return lastResolved;
      }
      console.warn(
        `verity: could not resolve ${label} ${latestTag}; falling back to ${fallback}: ${String(error)}`,
      );
      cached = { value: fallback, expiresAt: now + Math.min(ttlMs, 60_000) };
      return fallback;
    }
  };
}
