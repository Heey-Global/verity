import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearRegistryTokenCache,
  createCachedImageVersionResolver,
  createPublishedDefaultResolver,
  parseWwwAuthenticate,
  registryFetch,
  releasePinnedRef,
  resolvePublicOciImageVersion,
  resolvePublicOciTagDigest,
  resolveWithTimeout,
  resolvePublicOciLatestSemverDigest,
  resolvePublicOciLatestSemverTag,
  selectLatestSemverTag,
  splitImageTagRef,
} from './oci-ref.js';

/** The URLs a stubbed `fetch` was actually asked for, in order. */
function requestedUrls(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): string[] {
  return fetchMock.mock.calls.map(([url]) =>
    typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
  );
}

describe('resolveWithTimeout', () => {
  it('does not block startup composition on a never-resolving registry resolver', async () => {
    vi.useFakeTimers();
    const resolution = resolveWithTimeout(() => new Promise<string>(() => undefined), 10_000);
    const assertion = expect(resolution).rejects.toThrow('registry resolution timed out');
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    vi.useRealTimers();
  });

  it('refuses a non-positive or non-finite bound instead of waiting forever', async () => {
    // A zero/NaN timeout would arm a timer that never fires (or fires instantly
    // and races), so the guard has to reject before any resolver work starts.
    const resolver = vi.fn<() => Promise<string>>();
    await expect(resolveWithTimeout(resolver, 0)).rejects.toThrow(
      'registry resolution timeout must be positive',
    );
    await expect(resolveWithTimeout(resolver, -1)).rejects.toThrow(
      'registry resolution timeout must be positive',
    );
    await expect(resolveWithTimeout(resolver, Number.NaN)).rejects.toThrow(
      'registry resolution timeout must be positive',
    );
    await expect(resolveWithTimeout(resolver, Number.POSITIVE_INFINITY)).rejects.toThrow(
      'registry resolution timeout must be positive',
    );
    expect(resolver).not.toHaveBeenCalled();
  });

  it('passes a resolved value straight through within the bound', async () => {
    await expect(
      resolveWithTimeout(() => Promise.resolve('ghcr.io/x@sha256:aaa'), 10_000),
    ).resolves.toBe('ghcr.io/x@sha256:aaa');
  });

  it('preserves an Error rejection and wraps a non-Error one as the cause', async () => {
    // Startup logs the failure reason, so a thrown string must not degrade to a
    // bare "[object Object]" — it is attached as the cause of a named Error.
    await expect(
      resolveWithTimeout(() => Promise.reject(new Error('ghcr 503')), 10_000),
    ).rejects.toThrow('ghcr 503');
    // A network stack that rejects with a bare string rather than an Error is
    // exactly the shape this wrapper exists to normalise.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const rejection = resolveWithTimeout(() => Promise.reject('socket hang up'), 10_000);
    const wrapped = await rejection.catch((error: unknown) => error);
    expect(wrapped).toBeInstanceOf(Error);
    expect((wrapped as Error).message).toBe('registry resolution failed');
    expect((wrapped as Error).cause).toBe('socket hang up');
  });
});

describe('parseWwwAuthenticate', () => {
  it('collects every quoted challenge parameter and ignores unquoted noise', () => {
    expect(
      parseWwwAuthenticate(
        'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:o/r:pull",error=invalid_token',
      ),
    ).toEqual({
      realm: 'https://ghcr.io/token',
      service: 'ghcr.io',
      scope: 'repository:o/r:pull',
    });
  });

  it('yields no parameters for a challenge that carries none', () => {
    expect(parseWwwAuthenticate('Basic')).toEqual({});
    expect(parseWwwAuthenticate('Bearer realm=')).toEqual({});
  });

  it('keeps an explicitly empty parameter value rather than dropping the key', () => {
    expect(parseWwwAuthenticate('Bearer realm="",service="ghcr.io"')).toEqual({
      realm: '',
      service: 'ghcr.io',
    });
  });
});

describe('splitImageTagRef', () => {
  it('splits a tagged ref at the first slash and the last colon', () => {
    expect(splitImageTagRef('ghcr.io/heey-global/verity/verity-sandbox:v1.15.3')).toEqual({
      registry: 'ghcr.io',
      repo: 'heey-global/verity/verity-sandbox',
      reference: 'v1.15.3',
    });
    expect(splitImageTagRef('localhost:5000/repo:tag')).toEqual({
      registry: 'localhost:5000',
      repo: 'repo',
      reference: 'tag',
    });
  });

  it('refuses refs that are not registry-qualified, not tagged, or digest-pinned', () => {
    // Each of these would otherwise produce a silently wrong registry/repo split
    // and then a request to an endpoint that does not exist.
    expect(() => splitImageTagRef('verity-sandbox:latest')).toThrow(
      'invalid tagged OCI ref: verity-sandbox:latest',
    );
    expect(() => splitImageTagRef('/repo:latest')).toThrow('invalid tagged OCI ref: /repo:latest');
    expect(() => splitImageTagRef('ghcr.io/repo')).toThrow('invalid tagged OCI ref: ghcr.io/repo');
    expect(() => splitImageTagRef('ghcr.io/repo@sha256:abc')).toThrow(
      'invalid tagged OCI ref: ghcr.io/repo@sha256:abc',
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Belt and braces for the tests that install fake timers: a failed assertion
  // skips their trailing restore, and the next test to await a real timeout
  // would then hang rather than fail.
  vi.useRealTimers();
  // The pull-token cache lives at module scope, so a token minted by one test
  // would otherwise change how many requests the next one makes.
  clearRegistryTokenCache();
});

describe('createPublishedDefaultResolver', () => {
  it('serves cached digests to zero-arg callers but re-resolves on forceRefresh', async () => {
    const resolve = vi
      .fn<(ref: string) => Promise<string>>()
      .mockResolvedValueOnce('ghcr.io/x@sha256:aaa')
      .mockResolvedValueOnce('ghcr.io/x@sha256:bbb');
    const resolver = createPublishedDefaultResolver(
      undefined,
      'ghcr.io/x:latest',
      'ghcr.io/x@sha256:fallback',
      'test image',
      resolve,
    );

    // First poll resolves and caches.
    expect(await resolver()).toBe('ghcr.io/x@sha256:aaa');
    // A second poll within the TTL reuses the cache — no extra registry hit.
    expect(await resolver()).toBe('ghcr.io/x@sha256:aaa');
    expect(resolve).toHaveBeenCalledOnce();

    // The provision path forces a live re-resolve past the cache…
    expect(await resolver(true)).toBe('ghcr.io/x@sha256:bbb');
    expect(resolve).toHaveBeenCalledTimes(2);
    // …and the fresh value is written back so the following poll agrees.
    expect(await resolver()).toBe('ghcr.io/x@sha256:bbb');
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('keeps a still-valid cached digest when a forceRefresh resolve fails', async () => {
    const resolve = vi
      .fn<(ref: string) => Promise<string>>()
      .mockResolvedValueOnce('ghcr.io/x@sha256:aaa')
      .mockRejectedValueOnce(new Error('registry down'));
    const resolver = createPublishedDefaultResolver(
      undefined,
      'ghcr.io/x:latest',
      'ghcr.io/x@sha256:fallback',
      'test image',
      resolve,
    );

    expect(await resolver()).toBe('ghcr.io/x@sha256:aaa');
    // A refresh that fails must not regress the live cache to the fallback digest.
    expect(await resolver(true)).toBe('ghcr.io/x@sha256:aaa');
  });

  it('prefers an expired resolved digest over the fallback when the registry is down', async () => {
    // The fallback names an artifact from whatever release was current when it
    // was hardcoded. A digest this deployment already resolved is the artifact
    // it was actually handing out, so it stays the better answer however stale
    // the cache entry got.
    const resolve = vi
      .fn<(ref: string) => Promise<string>>()
      .mockResolvedValueOnce('ghcr.io/x@sha256:aaa')
      .mockRejectedValue(new Error('registry down'));
    const resolver = createPublishedDefaultResolver(
      undefined,
      'ghcr.io/x:v1.15.3',
      'ghcr.io/x@sha256:fallback',
      'test image',
      resolve,
      0, // expire the cache immediately, so the failure path cannot read it
    );

    expect(await resolver()).toBe('ghcr.io/x@sha256:aaa');
    expect(await resolver()).toBe('ghcr.io/x@sha256:aaa');
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('falls back only when the registry never answered at all', async () => {
    const resolve = vi
      .fn<(ref: string) => Promise<string>>()
      .mockRejectedValue(new Error('registry down'));
    const resolver = createPublishedDefaultResolver(
      undefined,
      'ghcr.io/x:latest',
      'ghcr.io/x@sha256:fallback',
      'test image',
      resolve,
      0,
    );

    expect(await resolver()).toBe('ghcr.io/x@sha256:fallback');
  });

  it('bounds the resolve it awaits on the request path', async () => {
    const resolve = vi.fn(async (_ref: string, signal?: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
      return 'ghcr.io/x@sha256:aaa';
    });
    const resolver = createPublishedDefaultResolver(
      undefined,
      'ghcr.io/x:latest',
      'ghcr.io/x@sha256:fallback',
      'test image',
      resolve,
    );

    expect(await resolver()).toBe('ghcr.io/x@sha256:aaa');
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('returns the explicit override without touching the registry', async () => {
    const resolve = vi.fn<(ref: string) => Promise<string>>();
    const resolver = createPublishedDefaultResolver(
      'ghcr.io/x@sha256:pinned',
      'ghcr.io/x:latest',
      'ghcr.io/x@sha256:fallback',
      'test image',
      resolve,
    );

    expect(await resolver()).toBe('ghcr.io/x@sha256:pinned');
    expect(await resolver(true)).toBe('ghcr.io/x@sha256:pinned');
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('selectLatestSemverTag', () => {
  it('chooses the highest stable semver tag and ignores latest, majors, and v-prefixed aliases', () => {
    expect(
      selectLatestSemverTag([
        'latest',
        '1',
        '1.14',
        '1.14.8',
        'v1.14.9',
        '1.14.9',
        '1.15.0',
        '2.0.0-alpha.1',
      ]),
    ).toBe('1.15.0');
  });

  it('returns undefined when a registry exposes no stable semver feature tags', () => {
    expect(selectLatestSemverTag(['latest', 'v1.0.0', '1.0', 'dev'])).toBeUndefined();
  });
});

describe('registryFetch', () => {
  const CHALLENGE =
    'Bearer realm="https://auth.example/token",service="ghcr.io",scope="repository:o/r:pull"';
  const unauthorized = (challenge?: string) =>
    new Response(null, {
      status: 401,
      ...(challenge === undefined ? {} : { headers: { 'www-authenticate': challenge } }),
    });

  it('returns a non-401 response without attempting the token dance', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('body', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await registryFetch('ghcr.io', 'o/r', 'manifests/latest');
    expect(response.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('exchanges the challenge for a pull token and replays the read with it', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized(CHALLENGE))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'pull-token' })))
      .mockResolvedValueOnce(new Response('manifest-body'));
    vi.stubGlobal('fetch', fetchMock);

    const response = await registryFetch('ghcr.io', 'o/r', 'manifests/latest', {
      accept: 'application/json',
    });
    await expect(response.text()).resolves.toBe('manifest-body');
    expect(requestedUrls(fetchMock)).toEqual([
      'https://ghcr.io/v2/o/r/manifests/latest',
      'https://auth.example/token?service=ghcr.io&scope=repository%3Ao%2Fr%3Apull',
      'https://ghcr.io/v2/o/r/manifests/latest',
    ]);
    // The retry must carry BOTH the caller's headers and the bearer token —
    // dropping either turns an authorized read back into a 401 loop.
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toEqual({
      accept: 'application/json',
      authorization: 'Bearer pull-token',
    });
  });

  it('asks for a repository pull scope when the challenge names none', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized('Bearer realm="https://auth.example/token"'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'oauth-token' })))
      .mockResolvedValueOnce(new Response('manifest-body'));
    vi.stubGlobal('fetch', fetchMock);

    await registryFetch('ghcr.io', 'o/r', 'tags/list');
    // No service param, and the scope defaults to a pull on the repo we asked for.
    expect(requestedUrls(fetchMock)[1]).toBe(
      'https://auth.example/token?scope=repository%3Ao%2Fr%3Apull',
    );
    // `access_token` is the OAuth2 spelling some registries answer with; a
    // reader that only understands `token` would fail against them.
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toEqual({
      authorization: 'Bearer oauth-token',
    });
  });

  it('forwards the caller abort signal to every leg of the handshake', async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized(CHALLENGE))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'pull-token' })))
      .mockResolvedValueOnce(new Response('manifest-body'));
    vi.stubGlobal('fetch', fetchMock);

    await registryFetch('ghcr.io', 'o/r', 'tags/list', {}, controller.signal);
    // A token round trip that ignores cancellation would outlive the caller.
    expect(fetchMock.mock.calls.map(([, init]) => init?.signal)).toEqual([
      controller.signal,
      controller.signal,
      controller.signal,
    ]);
  });

  it('reuses a minted pull token instead of repeating the dance per read', async () => {
    // The version walk is three reads; without this each one is 401 → token →
    // retry, so one resolution cost nine requests to ghcr.io instead of three.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized(CHALLENGE))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'pull-token' })))
      .mockResolvedValue(new Response('body'));
    vi.stubGlobal('fetch', fetchMock);

    await registryFetch('ghcr.io', 'o/r', 'manifests/latest');
    await registryFetch('ghcr.io', 'o/r', 'blobs/sha256:config', { accept: 'application/json' });

    expect(requestedUrls(fetchMock)).toEqual([
      'https://ghcr.io/v2/o/r/manifests/latest',
      'https://auth.example/token?service=ghcr.io&scope=repository%3Ao%2Fr%3Apull',
      'https://ghcr.io/v2/o/r/manifests/latest',
      'https://ghcr.io/v2/o/r/blobs/sha256:config',
    ]);
    // The second read carries the cached bearer on its FIRST attempt, alongside
    // the caller's own headers.
    expect(fetchMock.mock.calls[3]?.[1]?.headers).toEqual({
      accept: 'application/json',
      authorization: 'Bearer pull-token',
    });
  });

  it('scopes the cached token to its own repository', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized(CHALLENGE))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'r-token' })))
      .mockResolvedValue(new Response('body'));
    vi.stubGlobal('fetch', fetchMock);

    await registryFetch('ghcr.io', 'o/r', 'manifests/latest');
    // A token minted for o/r must not be replayed at o/other — it is not scoped
    // for it, and the registry would answer 401 to a request that never had to
    // fail in the first place.
    await registryFetch('ghcr.io', 'o/other', 'manifests/latest');

    expect(fetchMock.mock.calls[3]?.[1]?.headers).toEqual({});
  });

  it('keeps a credentialed caller out of the shared anonymous cache', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized(CHALLENGE))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'privileged-token' })))
      .mockResolvedValue(new Response('body'));
    vi.stubGlobal('fetch', fetchMock);

    await registryFetch('ghcr.io', 'o/r', 'manifests/latest', { authorization: 'Basic secret' });
    // A token minted from someone's credential may carry a scope an anonymous
    // read could never have asked for, and this cache is process-wide — so the
    // next anonymous read must start from nothing, not inherit it.
    await registryFetch('ghcr.io', 'o/r', 'manifests/latest');

    expect(fetchMock.mock.calls[3]?.[1]?.headers).toEqual({});
  });

  it('recognises a credential whatever the caller capitalises it as', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized(CHALLENGE))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'privileged-token' })))
      .mockResolvedValue(new Response('body'));
    vi.stubGlobal('fetch', fetchMock);

    // Header names are case-insensitive over the wire, so `Authorization` is
    // the same credential — reading it as anonymous would file the resulting
    // token under the shared key.
    await registryFetch('ghcr.io', 'o/r', 'manifests/latest', { Authorization: 'Basic secret' });
    await registryFetch('ghcr.io', 'o/r', 'manifests/latest');

    expect(fetchMock.mock.calls[3]?.[1]?.headers).toEqual({});
  });

  it('does not cache a token the retry was forbidden with', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized(CHALLENGE))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'forbidden-token' })))
      // Some registries answer a bad bearer with 403 rather than 401…
      .mockResolvedValueOnce(new Response('denied', { status: 403 }))
      .mockResolvedValueOnce(unauthorized(CHALLENGE))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'good-token' })))
      .mockResolvedValue(new Response('body'));
    vi.stubGlobal('fetch', fetchMock);

    await registryFetch('ghcr.io', 'o/r', 'manifests/latest');
    await registryFetch('ghcr.io', 'o/r', 'manifests/latest');

    // …so caching it would hand the next read a token this one already knows
    // is bad, exactly as a cached 401 would.
    expect(fetchMock.mock.calls[3]?.[1]?.headers).toEqual({});
  });

  it('leaves a token a concurrent read minted while this one was being refused', async () => {
    let refuseSlowRead: (() => void) | undefined;
    const refusalReaches = new Promise<void>((resolve) => {
      refuseSlowRead = resolve;
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized(CHALLENGE))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'first-token' })))
      .mockResolvedValueOnce(new Response('body'))
      // The slow read replays `first-token` and is refused — but the refusal
      // only lands after the read below has replaced the cache entry. 403 so it
      // returns there rather than minting a third token over the assertion.
      .mockImplementationOnce(async () => {
        await refusalReaches;
        return new Response('denied', { status: 403 });
      })
      .mockResolvedValueOnce(unauthorized(CHALLENGE))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'second-token' })))
      .mockResolvedValue(new Response('body'));
    vi.stubGlobal('fetch', fetchMock);

    await registryFetch('ghcr.io', 'o/r', 'manifests/latest');
    // Both of these read `first-token` out of the cache; the second one gets
    // its refusal first, evicts, and stores `second-token`.
    const slow = registryFetch('ghcr.io', 'o/r', 'manifests/latest');
    await registryFetch('ghcr.io', 'o/r', 'manifests/latest');
    refuseSlowRead?.();
    await slow;

    // Evicting by key would drop `second-token` here and make the next reader
    // pay a full walk to rediscover what the cache already held.
    fetchMock.mockClear();
    await registryFetch('ghcr.io', 'o/r', 'manifests/latest');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      authorization: 'Bearer second-token',
    });
  });

  it('replaces the caller credential on the retry instead of sending both', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized(CHALLENGE))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'minted-token' })))
      .mockResolvedValue(new Response('body'));
    vi.stubGlobal('fetch', fetchMock);

    await registryFetch('ghcr.io', 'o/r', 'manifests/latest', {
      accept: 'application/json',
      Authorization: 'Basic secret',
    });

    // Keeping both keys would reach the registry as one comma-joined
    // `authorization` header — and the refused credential is exactly the one
    // the challenge told us not to send again.
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toEqual({
      accept: 'application/json',
      authorization: 'Bearer minted-token',
    });
  });

  it('does not cache a minted token the retry itself was refused with', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized(CHALLENGE))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'rejected-token' })))
      // The registry refuses the token it just minted…
      .mockResolvedValueOnce(unauthorized(CHALLENGE))
      .mockResolvedValueOnce(unauthorized(CHALLENGE))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'good-token' })))
      .mockResolvedValue(new Response('body'));
    vi.stubGlobal('fetch', fetchMock);

    await registryFetch('ghcr.io', 'o/r', 'manifests/latest');
    await registryFetch('ghcr.io', 'o/r', 'manifests/latest');

    // …so the next read must start clean rather than spend a round trip
    // rediscovering that the cached token does not work.
    expect(fetchMock.mock.calls[3]?.[1]?.headers).toEqual({});
  });

  it('does not let a refused credentialed read evict the anonymous token', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized(CHALLENGE))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'pull-token' })))
      .mockResolvedValueOnce(new Response('body'))
      // Someone else's credential is rejected outright — that says nothing
      // about the anonymous token this cache holds.
      .mockResolvedValueOnce(unauthorized(CHALLENGE))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'other-token' })))
      .mockResolvedValue(new Response('body'));
    vi.stubGlobal('fetch', fetchMock);

    await registryFetch('ghcr.io', 'o/r', 'manifests/latest');
    await registryFetch('ghcr.io', 'o/r', 'manifests/latest', { authorization: 'Basic secret' });
    await registryFetch('ghcr.io', 'o/r', 'manifests/latest');

    expect(fetchMock.mock.calls[6]?.[1]?.headers).toEqual({
      authorization: 'Bearer pull-token',
    });
  });

  it('re-mints a cached token the registry has stopped accepting', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized(CHALLENGE))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'first-token' })))
      .mockResolvedValueOnce(new Response('body'))
      // The cached token has lapsed early at the registry's end…
      .mockResolvedValueOnce(unauthorized(CHALLENGE))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'second-token' })))
      .mockResolvedValueOnce(new Response('body'));
    vi.stubGlobal('fetch', fetchMock);

    await registryFetch('ghcr.io', 'o/r', 'manifests/latest');
    await registryFetch('ghcr.io', 'o/r', 'manifests/latest');

    // …so the retry must carry the freshly minted one, never the rejected one.
    expect(fetchMock.mock.calls[5]?.[1]?.headers).toEqual({
      authorization: 'Bearer second-token',
    });
  });

  it('drops a cached token a registry refuses with 403 rather than 401', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized(CHALLENGE))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'first-token' })))
      .mockResolvedValueOnce(new Response('body'))
      // Not every registry answers a lapsed bearer with the spec's 401.
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(unauthorized(CHALLENGE))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'second-token' })))
      .mockResolvedValue(new Response('body'));
    vi.stubGlobal('fetch', fetchMock);

    await registryFetch('ghcr.io', 'o/r', 'manifests/latest');
    // The 403 reaches the caller as it is — a forbidden repository must not be
    // reported as a missing auth challenge — but the token behind it is gone…
    expect((await registryFetch('ghcr.io', 'o/r', 'manifests/latest')).status).toBe(403);
    await registryFetch('ghcr.io', 'o/r', 'manifests/latest');

    // …so the next read starts clean instead of replaying it until it lapses.
    expect(fetchMock.mock.calls[4]?.[1]?.headers).toEqual({});
    expect(fetchMock.mock.calls[6]?.[1]?.headers).toEqual({
      authorization: 'Bearer second-token',
    });
  });

  it('expires a cached token before the lifetime the registry gave it', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized(CHALLENGE))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'pull-token', expires_in: 300 })))
      .mockResolvedValue(new Response('body'));
    vi.stubGlobal('fetch', fetchMock);

    await registryFetch('ghcr.io', 'o/r', 'manifests/latest');
    // Still inside the (margin-adjusted) lifetime: reused without a dance.
    vi.advanceTimersByTime(289_000);
    await registryFetch('ghcr.io', 'o/r', 'manifests/latest');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // Past it, the read starts unauthenticated again rather than replaying a
    // bearer that is about to lapse mid-flight.
    vi.advanceTimersByTime(2_000);
    await registryFetch('ghcr.io', 'o/r', 'manifests/latest');
    expect(fetchMock.mock.calls[4]?.[1]?.headers).toEqual({});
    vi.useRealTimers();
  });

  it('names the repository when a 401 arrives without a challenge header', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(unauthorized());
    vi.stubGlobal('fetch', fetchMock);

    await expect(registryFetch('ghcr.io', 'o/r', 'tags/list')).rejects.toThrow(
      'registry auth challenge missing for ghcr.io/o/r',
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('refuses a challenge with no realm to fetch a token from', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized('Bearer service="ghcr.io",scope="repository:o/r:pull"'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(registryFetch('ghcr.io', 'o/r', 'tags/list')).rejects.toThrow(
      'registry auth realm missing for ghcr.io/o/r',
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('reports the token endpoint status when the token request itself fails', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized(CHALLENGE))
      .mockResolvedValueOnce(new Response('nope', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(registryFetch('ghcr.io', 'o/r', 'tags/list')).rejects.toThrow(
      'registry token request failed for ghcr.io/o/r: HTTP 503',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses a token response that carries no usable token', async () => {
    // Both shapes below would otherwise produce `Bearer undefined` / `Bearer ` —
    // a retry that fails at the registry with a far less obvious error.
    for (const body of [{}, { token: 42 }, { token: '' }, { access_token: '' }]) {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(unauthorized(CHALLENGE))
        .mockResolvedValueOnce(new Response(JSON.stringify(body)));
      vi.stubGlobal('fetch', fetchMock);

      await expect(registryFetch('ghcr.io', 'o/r', 'tags/list')).rejects.toThrow(
        'registry token response had no token for ghcr.io/o/r',
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });
});

describe('resolvePublicOciTagDigest', () => {
  it('reports the manifest status when the registry refuses the read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('no such tag', { status: 404 })),
    );

    await expect(resolvePublicOciTagDigest('ghcr.io/o/r:latest')).rejects.toThrow(
      'registry manifest request failed for ghcr.io/o/r:latest: HTTP 404',
    );
  });

  it('refuses a manifest response with no sha256 content digest to pin to', async () => {
    // Without the digest header there is nothing immutable to pin, and silently
    // returning the tag would defeat the point of resolving at all.
    for (const headers of [{}, { 'docker-content-digest': 'md5:abc' }]) {
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({}), { headers })),
      );
      await expect(resolvePublicOciTagDigest('ghcr.io/o/r:latest')).rejects.toThrow(
        'registry manifest response had no digest for ghcr.io/o/r:latest',
      );
    }
  });
});

describe('resolvePublicOciLatestSemverTag', () => {
  it('follows registry tag pagination before choosing the latest semver tag', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ tags: ['1.14.9', '3.10.0'] }), {
          headers: {
            link: '</v2/heey-global/verity/verity-sandbox-toolkit/tags/list?last=3.10.0>; rel="next"',
          },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ tags: ['3.18.0', '3.18.1'] })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      resolvePublicOciLatestSemverTag('ghcr.io/heey-global/verity/verity-sandbox-toolkit:latest'),
    ).resolves.toBe('ghcr.io/heey-global/verity/verity-sandbox-toolkit:3.18.1');
    expect(
      fetchMock.mock.calls.map(([url]) =>
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      ),
    ).toEqual([
      'https://ghcr.io/v2/heey-global/verity/verity-sandbox-toolkit/tags/list',
      'https://ghcr.io/v2/heey-global/verity/verity-sandbox-toolkit/tags/list?last=3.10.0',
    ]);
  });

  it('follows an absolute next link but only within the same repository', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ tags: ['1.0.0'] }), {
          headers: { link: '<https://ghcr.io/v2/o/r/tags/list?last=1.0.0&n=100>; rel="next"' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ tags: ['1.2.0'] }), {
          // A next link pointing at a DIFFERENT repository must end pagination
          // rather than send the next read somewhere else entirely.
          headers: { link: '</v2/other/repo/tags/list?last=9.9.9>; rel="next"' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolvePublicOciLatestSemverTag('ghcr.io/o/r:latest')).resolves.toBe(
      'ghcr.io/o/r:1.2.0',
    );
    expect(requestedUrls(fetchMock)).toEqual([
      'https://ghcr.io/v2/o/r/tags/list',
      'https://ghcr.io/v2/o/r/tags/list?last=1.0.0&n=100',
    ]);
  });

  it('ignores link entries that are not a well-formed rel=next target', async () => {
    for (const link of [
      '</v2/o/r/tags/list?last=1.0.0>; rel="prev"',
      '/v2/o/r/tags/list?last=1.0.0; rel="next"',
      '<https://ghcr.io/v2/o/r/tags/list; rel="next"',
    ]) {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ tags: ['1.0.0'] }), { headers: { link } }),
        );
      vi.stubGlobal('fetch', fetchMock);

      await expect(resolvePublicOciLatestSemverTag('ghcr.io/o/r:latest')).resolves.toBe(
        'ghcr.io/o/r:1.0.0',
      );
      expect(fetchMock).toHaveBeenCalledOnce();
    }
  });

  it('reports the tags-list status when the registry refuses the listing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('denied', { status: 403 })),
    );

    await expect(resolvePublicOciLatestSemverTag('ghcr.io/o/r:latest')).rejects.toThrow(
      'registry tags request failed for ghcr.io/o/r:latest: HTTP 403',
    );
  });

  it('refuses to invent a tag when the listing holds no stable semver', async () => {
    // Silently returning `:latest` here would pin the Sandbox to a moving tag,
    // which is exactly what resolving a release artifact is meant to avoid.
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ tags: ['latest', 'dev', 7] }))),
    );

    await expect(resolvePublicOciLatestSemverTag('ghcr.io/o/r:latest')).rejects.toThrow(
      'registry tags response had no semver tags for ghcr.io/o/r:latest',
    );
  });
});

describe('resolvePublicOciLatestSemverDigest', () => {
  it('pins the selected latest semver tag to its immutable manifest digest', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ tags: ['3.18.1', '3.18.2'] })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ schemaVersion: 2 }), {
          headers: { 'docker-content-digest': 'sha256:feature-digest' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      resolvePublicOciLatestSemverDigest(
        'ghcr.io/heey-global/verity/verity-sandbox-toolkit:latest',
      ),
    ).resolves.toBe('ghcr.io/heey-global/verity/verity-sandbox-toolkit@sha256:feature-digest');
    expect(
      fetchMock.mock.calls.map(([url]) =>
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      ),
    ).toEqual([
      'https://ghcr.io/v2/heey-global/verity/verity-sandbox-toolkit/tags/list',
      'https://ghcr.io/v2/heey-global/verity/verity-sandbox-toolkit/manifests/3.18.2',
    ]);
  });
});

describe('resolvePublicOciImageVersion', () => {
  it('reads the version label from the image config selected by the target digest', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            manifests: [
              {
                digest: 'sha256:manifest',
                platform: { os: 'linux', architecture: 'amd64' },
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ config: { digest: 'sha256:config' } })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ config: { Labels: { 'org.opencontainers.image.version': 'v1.18.0' } } }),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      resolvePublicOciImageVersion('ghcr.io/heey-global/verity/verity-sandbox@sha256:index'),
    ).resolves.toBe('v1.18.0');
    expect(
      fetchMock.mock.calls.map(([url]) =>
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      ),
    ).toEqual([
      'https://ghcr.io/v2/heey-global/verity/verity-sandbox/manifests/sha256:index',
      'https://ghcr.io/v2/heey-global/verity/verity-sandbox/manifests/sha256:manifest',
      'https://ghcr.io/v2/heey-global/verity/verity-sandbox/blobs/sha256:config',
    ]);
  });

  it('falls back to the first index entry when no linux/amd64 platform is listed', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            manifests: [
              { digest: 'sha256:arm', platform: { os: 'linux', architecture: 'arm64' } },
              { digest: 'sha256:win', platform: { os: 'windows', architecture: 'amd64' } },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ config: { digest: 'sha256:config' } })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            config: { Labels: { 'org.opencontainers.image.version': ' 1.18.0 ' } },
          }),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    // The label is reported trimmed, so a padded value still compares equal to
    // the version the Server was built with.
    await expect(resolvePublicOciImageVersion('ghcr.io/o/r:latest')).resolves.toBe('1.18.0');
    expect(requestedUrls(fetchMock)[1]).toBe('https://ghcr.io/v2/o/r/manifests/sha256:arm');
  });

  it('reports no version rather than a blank one when the label is absent or empty', async () => {
    for (const config of [
      {},
      { config: { Labels: {} } },
      { config: { Labels: { 'org.opencontainers.image.version': '   ' } } },
    ]) {
      vi.stubGlobal(
        'fetch',
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(JSON.stringify({ config: { digest: 'sha256:c' } })))
          .mockResolvedValueOnce(new Response(JSON.stringify(config))),
      );
      await expect(
        resolvePublicOciImageVersion('ghcr.io/o/r@sha256:index'),
      ).resolves.toBeUndefined();
    }
  });

  it('maps each leg of the manifest walk to a distinct failure message', async () => {
    const index = JSON.stringify({
      manifests: [{ digest: 'sha256:m', platform: { os: 'linux', architecture: 'amd64' } }],
    });
    const cases: { fetches: Response[]; message: string }[] = [
      {
        fetches: [new Response('gone', { status: 404 })],
        message: 'registry manifest request failed for ghcr.io/o/r:latest: HTTP 404',
      },
      {
        fetches: [new Response(JSON.stringify({ manifests: [] }))],
        message: 'registry image index was empty for ghcr.io/o/r:latest',
      },
      {
        fetches: [new Response(index), new Response('gone', { status: 500 })],
        message: 'registry image manifest request failed for ghcr.io/o/r:latest: HTTP 500',
      },
      {
        fetches: [new Response(index), new Response(JSON.stringify({ schemaVersion: 2 }))],
        message: 'registry image manifest had no config for ghcr.io/o/r:latest',
      },
      {
        fetches: [
          new Response(index),
          new Response(JSON.stringify({ config: { digest: 'sha256:c' } })),
          new Response('gone', { status: 502 }),
        ],
        message: 'registry image config request failed for ghcr.io/o/r:latest: HTTP 502',
      },
    ];

    for (const { fetches, message } of cases) {
      const fetchMock = vi.fn<typeof fetch>();
      for (const response of fetches) fetchMock.mockResolvedValueOnce(response);
      vi.stubGlobal('fetch', fetchMock);
      await expect(resolvePublicOciImageVersion('ghcr.io/o/r:latest')).rejects.toThrow(message);
    }
  });

  it('refuses a digest ref that names no registry or no digest', async () => {
    // These would otherwise be split into an empty registry/repo and issue a
    // request to `https:///v2//manifests/`.
    await expect(resolvePublicOciImageVersion('verity-sandbox@sha256:abc')).rejects.toThrow(
      'invalid OCI ref: verity-sandbox@sha256:abc',
    );
    await expect(resolvePublicOciImageVersion('ghcr.io/o/r@')).rejects.toThrow(
      'invalid OCI ref: ghcr.io/o/r@',
    );
    // A ref with neither digest nor tag falls through to the tagged split.
    await expect(resolvePublicOciImageVersion('ghcr.io/o/r')).rejects.toThrow(
      'invalid tagged OCI ref: ghcr.io/o/r',
    );
  });
});

describe('createCachedImageVersionResolver', () => {
  it('walks the registry once per ref per TTL window', async () => {
    vi.useFakeTimers();
    const resolve = vi.fn(async () => 'v1.18.0');
    const resolver = createCachedImageVersionResolver({ resolve, ttlMs: 5 * 60 * 1000 });

    await expect(resolver('ghcr.io/o/r@sha256:a')).resolves.toBe('v1.18.0');
    vi.advanceTimersByTime(4 * 60 * 1000);
    await expect(resolver('ghcr.io/o/r@sha256:a')).resolves.toBe('v1.18.0');
    expect(resolve).toHaveBeenCalledTimes(1);
    // A different ref is a different answer and must not read the first one's.
    await expect(resolver('ghcr.io/o/r@sha256:b')).resolves.toBe('v1.18.0');
    expect(resolve).toHaveBeenCalledTimes(2);
    // Past the TTL the ref is walked again.
    vi.advanceTimersByTime(2 * 60 * 1000);
    await expect(resolver('ghcr.io/o/r@sha256:a')).resolves.toBe('v1.18.0');
    expect(resolve).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('joins concurrent callers onto one in-flight walk', async () => {
    // The fan-out this exists to stop is concurrent, not sequential: a project
    // list asks for the same ref P times before the first answer lands.
    let release: (version: string) => void = () => undefined;
    const resolve = vi.fn(
      () =>
        new Promise<string | undefined>((resolveOne) => {
          release = resolveOne;
        }),
    );
    const resolver = createCachedImageVersionResolver({ resolve });

    const pending = Array.from({ length: 10 }, () => resolver('ghcr.io/o/r@sha256:a'));
    release('v1.18.0');

    await expect(Promise.all(pending)).resolves.toEqual(
      Array.from({ length: 10 }, () => 'v1.18.0'),
    );
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('caches a failure briefly rather than re-walking on every poll', async () => {
    vi.useFakeTimers();
    const resolve = vi.fn(async () => {
      throw new Error('registry down');
    });
    const resolver = createCachedImageVersionResolver({ resolve, failureTtlMs: 60_000 });

    // The rejection is passed to the caller — it decides whether to warn — but
    // an outage must not turn every poll into a fresh failed walk.
    await expect(resolver('ghcr.io/o/r@sha256:a')).rejects.toThrow('registry down');
    await expect(resolver('ghcr.io/o/r@sha256:a')).rejects.toThrow('registry down');
    expect(resolve).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(61_000);
    await expect(resolver('ghcr.io/o/r@sha256:a')).rejects.toThrow('registry down');
    expect(resolve).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('keeps serving the last version it did resolve through a later failure', async () => {
    vi.useFakeTimers();
    let fail = false;
    const resolve = vi.fn(async () => {
      if (fail) throw new Error('registry down');
      return 'v1.18.0';
    });
    const resolver = createCachedImageVersionResolver({ ttlMs: 5 * 60 * 1000, resolve });

    await expect(resolver('ghcr.io/o/r@sha256:a')).resolves.toBe('v1.18.0');
    fail = true;
    vi.advanceTimersByTime(6 * 60 * 1000);
    // The ref is a digest, so the answer it gave cannot have changed — blanking
    // the version in the overview over a blip would be strictly worse.
    await expect(resolver('ghcr.io/o/r@sha256:a')).resolves.toBe('v1.18.0');
    // A ref that never resolved has nothing to fall back on and still rejects.
    await expect(resolver('ghcr.io/o/r@sha256:b')).rejects.toThrow('registry down');
    vi.useRealTimers();
  });

  it('does not mistake "this ref carries no version" for a last-good answer', async () => {
    vi.useFakeTimers();
    let fail = false;
    const resolve = vi.fn(async () => {
      if (fail) throw new Error('registry down');
      return undefined;
    });
    const resolver = createCachedImageVersionResolver({ ttlMs: 5 * 60 * 1000, resolve });

    await expect(resolver('ghcr.io/o/r@sha256:a')).resolves.toBeUndefined();
    fail = true;
    vi.advanceTimersByTime(6 * 60 * 1000);
    // Remembering the label-less answer would make the outage indistinguishable
    // from it, so `resolveSandboxVersion` would never see an error to warn about.
    await expect(resolver('ghcr.io/o/r@sha256:a')).rejects.toThrow('registry down');
    vi.useRealTimers();
  });

  it('releases an in-flight entry whose walk neither settles nor aborts', async () => {
    vi.useFakeTimers();
    const resolve = vi.fn(() => new Promise<string | undefined>(() => undefined));
    const resolver = createCachedImageVersionResolver({ resolve, timeoutMs: 10_000 });

    void resolver('ghcr.io/o/r@sha256:a');
    void resolver('ghcr.io/o/r@sha256:a');
    expect(resolve).toHaveBeenCalledTimes(1);
    // A resolver that ignores its signal would otherwise pin this ref to a walk
    // that never answers for the process lifetime — and `GET /projects` awaits it.
    vi.advanceTimersByTime(10_001);
    void resolver('ghcr.io/o/r@sha256:a');
    expect(resolve).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('bounds the walk with a timeout signal', async () => {
    const resolve = vi.fn(async (_ref: string, signal?: AbortSignal) => {
      expect(signal?.aborted).toBe(false);
      return 'v1.18.0';
    });
    const resolver = createCachedImageVersionResolver({ resolve, timeoutMs: 25 });

    await expect(resolver('ghcr.io/o/r@sha256:a')).resolves.toBe('v1.18.0');
    // A registry that accepts the connection and then stalls must not hold the
    // request path open: the signal the walk was handed does fire.
    const signal = resolve.mock.calls[0]?.[1];
    expect(signal).toBeInstanceOf(AbortSignal);
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  });

  it('threads the abort signal through every leg of a real version walk', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            manifests: [{ digest: 'sha256:m', platform: { os: 'linux', architecture: 'amd64' } }],
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ config: { digest: 'sha256:c' } })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ config: { Labels: { 'org.opencontainers.image.version': 'v1.18.0' } } }),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const resolver = createCachedImageVersionResolver();
    await expect(resolver('ghcr.io/o/r@sha256:index')).resolves.toBe('v1.18.0');

    const signals = fetchMock.mock.calls.map(([, init]) => init?.signal);
    expect(signals).toHaveLength(3);
    // One bound for the whole three-request walk, not one per leg.
    expect(new Set(signals).size).toBe(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });
});

describe('releasePinnedRef', () => {
  const IMAGE_REPO = 'ghcr.io/heey-global/verity/verity-sandbox';
  const FEATURE_REPO = 'ghcr.io/heey-global/verity/verity-sandbox-toolkit';

  it('names each sibling artifact under the tag release.yml actually pushes', () => {
    // The sandbox IMAGE is published as v<version> only — no bare semver tag
    // exists — while the toolkit FEATURE is published under bare semver, its
    // v-prefixed tag being a visible-version index and not a Feature manifest.
    // Getting either shape wrong yields a ref that resolves to nothing.
    expect(releasePinnedRef(IMAGE_REPO, 'v', '1.15.3')).toBe(
      'ghcr.io/heey-global/verity/verity-sandbox:v1.15.3',
    );
    expect(releasePinnedRef(FEATURE_REPO, '', '1.15.3')).toBe(
      'ghcr.io/heey-global/verity/verity-sandbox-toolkit:1.15.3',
    );
    expect(releasePinnedRef(IMAGE_REPO, 'v', ' 1.15.3 ')).toBe(
      'ghcr.io/heey-global/verity/verity-sandbox:v1.15.3',
    );
  });

  it('pins nothing on a build that never ran semantic-release', () => {
    // Dev/PR builds carry the sentinel or nothing at all. There is no release
    // artifact under that name, so these keep the published-latest behavior
    // rather than resolving a tag that does not exist.
    expect(releasePinnedRef(IMAGE_REPO, 'v', '0.0.0-dev')).toBeUndefined();
    expect(releasePinnedRef(IMAGE_REPO, 'v', undefined)).toBeUndefined();
    expect(releasePinnedRef(IMAGE_REPO, 'v', '')).toBeUndefined();
  });

  it('refuses anything that is not an exact major.minor.patch', () => {
    // A prerelease or channel name would produce a ref that resolves to nothing
    // — worse than falling back, because the fallback at least exists.
    expect(releasePinnedRef(IMAGE_REPO, 'v', 'v1.15.3')).toBeUndefined();
    expect(releasePinnedRef(IMAGE_REPO, 'v', '1.15')).toBeUndefined();
    expect(releasePinnedRef(IMAGE_REPO, 'v', '1.15.3-rc.1')).toBeUndefined();
    expect(releasePinnedRef(IMAGE_REPO, 'v', 'latest')).toBeUndefined();
  });
});
