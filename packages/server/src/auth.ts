// Control-plane API authentication (audit C1). The master password is the single
// entry point: proving it (via /secret/init | /secret/unlock) mints a per-device
// bearer token that every other route then requires. Tokens are high-entropy
// random strings; only their SHA-256 hash is persisted (packages/store
// `auth_tokens`), so a DB read yields no usable credential and the raw token
// lives only in the device keychain.
//
// The registry keeps an in-memory Set of valid hashes seeded from the store at
// startup, so the per-request gate is an O(1) Set lookup with no DB round-trip.
// It survives restarts (Variant B, per-device tokens): the hashes reload from
// the durable table, so a device does not re-authenticate on every server boot —
// only when its token is revoked or the master password changes.
import { createHash, randomBytes } from 'node:crypto';

/** 256-bit token — overwhelming brute-force margin, so a fast SHA-256 hash (no
 *  salt/KDF) is sufficient at rest: there is nothing to grind. */
const TOKEN_BYTES = 32;
/** Opaque public handle for listing/revoking a device without touching the token. */
const ID_BYTES = 9;

/** SHA-256 hex of a raw token — the value stored and matched by the gate. */
export function hashAuthToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Pull the token out of an `Authorization: Bearer <token>` header. */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match ? match[1] : undefined;
}

/** Pull an `access_token` query param from a raw request URL. WebSocket
 *  handshakes can't set the Authorization header, so the live stream presents
 *  its token here instead. */
export function accessTokenQuery(url: string): string | undefined {
  const q = url.indexOf('?');
  if (q < 0) return undefined;
  return new URLSearchParams(url.slice(q + 1)).get('access_token') ?? undefined;
}

/** Replace the value of an `access_token` query param with `REDACTED`, leaving the
 *  rest of the URL byte-identical (audit M4). The WS bearer token must ride the
 *  query string — a WebSocket handshake can't set headers — so without this it
 *  lands verbatim in the request log (and any upstream access log), where a valid,
 *  long-lived credential must never sit. No-op when there is no such param. */
export function redactAccessTokenInUrl(url: string): string {
  return url.replace(/([?&]access_token=)[^&#]*/gi, '$1REDACTED');
}

/** Decide whether a WebSocket upgrade may proceed given an optional Origin
 *  allowlist and the request's `Origin` header (anti-CSWSH, defence-in-depth).
 *  Permissive by design: no allowlist configured → always allowed; a MISSING
 *  Origin (native clients don't send one, and a browser CSWSH always does) →
 *  allowed. Only a PRESENT Origin absent from a non-empty allowlist is refused. */
export function wsOriginAllowed(
  allowedOrigins: readonly string[] | undefined,
  origin: string | undefined,
): boolean {
  if (allowedOrigins === undefined || allowedOrigins.length === 0) return true;
  if (origin === undefined) return true;
  return allowedOrigins.includes(origin);
}

/** The slice of the store the registry needs — kept structural so the registry
 *  is trivially unit-testable without a real database. */
export interface AuthTokenStore {
  listAuthTokens(): Promise<Array<{ id: string; tokenHash: string }>>;
  insertAuthToken(record: { id: string; tokenHash: string; label?: string | null }): Promise<void>;
}

export interface MintedAuthToken {
  /** The RAW bearer token — returned to the device exactly once, never re-derivable. */
  token: string;
  /** The token's opaque public id (for later revocation). */
  id: string;
}

export interface AuthTokenRegistry {
  /** True when the gate should ENFORCE auth. Off until a master password exists
   *  (env-key/headless deployments have no interactive credential to gate with). */
  isEnabled(): boolean;
  /** Turn enforcement on — called once, right after the first /secret/init. */
  enable(): void;
  /** Does this raw bearer token match a known device? Constant-margin: the token
   *  is 256-bit random, so a plain Map lookup is not a useful timing oracle. */
  verify(token: string | undefined | null): boolean;
  /** Resolve a verified raw token to Verity's opaque paired-device handle. */
  resolveId(token: string | undefined | null): string | undefined;
  /** Whether a paired-device handle is still active, for delayed policy rechecks. */
  isKnownId?(id: string): boolean;
  /** Mint a new device token, persist its hash, and return the raw token once. */
  mint(label?: string | null): Promise<MintedAuthToken>;
  /** Drop a single hash from the in-memory set (after the row is deleted). */
  forget(tokenHash: string): void;
  /** Clear the whole in-memory set (after deleteAllAuthTokens). */
  clear(): void;
}

/** Build the registry, seeding the in-memory hash-to-device map from the durable store.
 *  `enabled` reflects whether a master password already exists at startup — auth
 *  is master-password only (onboarding via the app); there is no headless/env-key
 *  bypass. */
export async function createAuthTokenRegistry(
  store: AuthTokenStore,
  opts: { enabled: boolean },
): Promise<AuthTokenRegistry> {
  const tokenIdsByHash = new Map(
    (await store.listAuthTokens()).map((record) => [record.tokenHash, record.id]),
  );
  let enabled = opts.enabled;
  return {
    isEnabled: (): boolean => enabled,
    enable: (): void => {
      enabled = true;
    },
    verify(token): boolean {
      if (token === undefined || token === null || token.length === 0) return false;
      return tokenIdsByHash.has(hashAuthToken(token));
    },
    resolveId(token): string | undefined {
      if (token === undefined || token === null || token.length === 0) return undefined;
      return tokenIdsByHash.get(hashAuthToken(token));
    },
    isKnownId(id): boolean {
      return [...tokenIdsByHash.values()].includes(id);
    },
    async mint(label): Promise<MintedAuthToken> {
      const token = randomBytes(TOKEN_BYTES).toString('base64url');
      const id = randomBytes(ID_BYTES).toString('base64url');
      const tokenHash = hashAuthToken(token);
      await store.insertAuthToken({ id, tokenHash, label: label ?? null });
      tokenIdsByHash.set(tokenHash, id);
      return { token, id };
    },
    forget(tokenHash): void {
      tokenIdsByHash.delete(tokenHash);
    },
    clear(): void {
      tokenIdsByHash.clear();
    },
  };
}
