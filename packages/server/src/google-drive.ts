// Google Drive connection + API wrapper for importing reference docs (ADR 0009).
//
// The connect flow is native-app OAuth (PKCE): the mobile app runs the
// authorization request in the system browser against an *iOS* OAuth client (no
// client secret), Google redirects back into the app, and the app forwards the
// one-time `code` + PKCE `codeVerifier` to the server. The server does the
// code→token exchange here — an OUTBOUND call, so it works even though the Verity
// server is never publicly reachable. The long-lived refresh token stays
// server-side (SecretCipher-encrypted in verity_settings); access tokens are
// short-lived and refreshed on demand.
//
// Security posture mirrors github-app-token.ts: failures map to fixed, redacted
// messages and never echo a full upstream body (Google token errors are lifted
// to their short `error` code only — e.g. `invalid_grant` — which is safe and
// useful, never the raw body which could carry more).

import { createHash } from 'node:crypto';

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 50_000_000;

/** Minimal structural subset of the WHATWG `fetch` response this module needs.
 *  Narrower than `HttpResponse` in github.ts because Drive downloads/exports need
 *  raw bytes (`arrayBuffer`). The global `fetch` Response satisfies this. */
export interface GoogleHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  headers?: { get(name: string): string | null } | undefined;
  body?: ReadableStream<Uint8Array> | null | undefined;
}

export type GoogleFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<GoogleHttpResponse>;

interface GoogleTransportOptions {
  fetch?: GoogleFetch | undefined;
  timeoutMs?: number | undefined;
  /** Hard cap for a downloaded or exported file. */
  maxDownloadBytes?: number | undefined;
}

/** Tokens returned by the OAuth token endpoint. `refreshToken` is present only on
 *  the initial code exchange (with `access_type=offline`); a refresh call returns
 *  a fresh access token and normally omits it. */
export interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds: number;
}

/** A stable, redaction-safe failure. `.reason` is a short machine code
 *  (`invalid_grant`, `network`, `http_<status>`, `malformed`) so the server can
 *  map it to user-facing copy without leaking upstream bodies or tokens. */
export class GoogleDriveError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'GoogleDriveError';
  }
}

interface GoogleTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
}

function resolveTransport(opts: GoogleTransportOptions): {
  doFetch: GoogleFetch;
  timeoutMs: number;
} {
  return {
    doFetch: opts.fetch ?? fetch,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

async function postToken(
  body: Record<string, string>,
  opts: GoogleTransportOptions,
): Promise<GoogleTokens> {
  const { doFetch, timeoutMs } = resolveTransport(opts);
  let res: GoogleHttpResponse;
  try {
    res = await doFetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new GoogleDriveError('could not reach Google', 'network');
  }

  const payload = (await res.json().catch(() => ({}))) as GoogleTokenResponse;
  if (!res.ok) {
    // Lift ONLY the short `error` code (e.g. invalid_grant, invalid_client) —
    // never `error_description` or the raw body, which can carry more detail.
    const code = typeof payload.error === 'string' ? payload.error : `http_${String(res.status)}`;
    throw new GoogleDriveError(`Google rejected the token request (${code})`, code);
  }

  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : '';
  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 0;
  if (accessToken.length === 0) {
    throw new GoogleDriveError('Google did not return an access token', 'malformed');
  }
  return {
    accessToken,
    ...(typeof payload.refresh_token === 'string' && payload.refresh_token.length > 0
      ? { refreshToken: payload.refresh_token }
      : {}),
    expiresInSeconds: expiresIn,
  };
}

/**
 * Exchange a PKCE authorization code for tokens (native iOS client — no secret).
 * `access_type=offline` is what makes Google mint a refresh token. `redirectUri`
 * MUST be the exact value the app used in the authorization request, so the app
 * forwards it alongside the code.
 */
export async function exchangeGoogleAuthCode(
  params: {
    clientId: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  },
  opts: GoogleTransportOptions = {},
): Promise<GoogleTokens> {
  return postToken(
    {
      client_id: params.clientId,
      code: params.code,
      code_verifier: params.codeVerifier,
      redirect_uri: params.redirectUri,
      grant_type: 'authorization_code',
    },
    opts,
  );
}

/** Mint a fresh access token from the stored refresh token. No secret (iOS
 *  client + PKCE). The result normally omits `refreshToken`. */
export async function refreshGoogleAccessToken(
  params: { clientId: string; refreshToken: string },
  opts: GoogleTransportOptions = {},
): Promise<GoogleTokens> {
  return postToken(
    {
      client_id: params.clientId,
      refresh_token: params.refreshToken,
      grant_type: 'refresh_token',
    },
    opts,
  );
}

async function driveGet(
  path: string,
  accessToken: string,
  opts: GoogleTransportOptions,
): Promise<GoogleHttpResponse> {
  const { doFetch, timeoutMs } = resolveTransport(opts);
  let res: GoogleHttpResponse;
  try {
    res = await doFetch(`${GOOGLE_DRIVE_API}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new GoogleDriveError('could not reach Google Drive', 'network');
  }
  if (!res.ok) {
    // 401 = access token expired/revoked (caller should refresh + retry); 403 =
    // Drive API disabled / insufficient scope / rate limit; 404 = file gone.
    // Google returns a short, safe reason slug in the error body
    // (`error.errors[0].reason` e.g. `accessNotConfigured`, `insufficientPermissions`,
    // `rateLimitExceeded`, or the newer `error.status` e.g. `PERMISSION_DENIED`).
    // Lift ONLY that slug into `.reason` — never the raw body — so an operator can
    // tell "Drive API not enabled" from "insufficient scope". Mirrors the token
    // posture of surfacing the short `error` code only.
    const slug = await extractDriveErrorSlug(res);
    throw new GoogleDriveError(
      `Google Drive returned an unexpected status (${String(res.status)})`,
      `http_${String(res.status)}${slug ? `_${slug}` : ''}`,
    );
  }
  return res;
}

/** Pull Google's short, safe error slug from a Drive API error body — the classic
 *  `error.errors[0].reason` (e.g. `accessNotConfigured`, `insufficientPermissions`,
 *  `rateLimitExceeded`) or the newer `error.status` (e.g. `PERMISSION_DENIED`).
 *  Sanitised to `[A-Za-z0-9]` and length-capped so no raw upstream text or token
 *  material can leak into `.reason`; returns undefined when the body has neither. */
async function extractDriveErrorSlug(res: GoogleHttpResponse): Promise<string | undefined> {
  const body = (await res.json().catch(() => undefined)) as
    { error?: { status?: unknown; errors?: unknown } } | undefined;
  const error = body?.error;
  if (typeof error !== 'object' || error === null) return undefined;
  let raw: string | undefined;
  const errors = (error as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first: unknown = errors[0];
    // Guard the element: a malformed `errors: [null]` / `[123]` must degrade to
    // undefined, never throw — this parser exists to tolerate untrusted bodies.
    if (typeof first === 'object' && first !== null) {
      const reason = (first as { reason?: unknown }).reason;
      if (typeof reason === 'string') raw = reason;
    }
  }
  if (raw === undefined) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'string') raw = status;
  }
  if (raw === undefined) return undefined;
  const slug = raw.replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
  return slug.length > 0 ? slug : undefined;
}

/** The connected account's email (`GET /about?fields=user`). Needs only the Drive
 *  scope — no extra `openid`/`email` scope — so the connect UI can echo which
 *  account is linked. */
export async function getDriveAccountEmail(
  accessToken: string,
  opts: GoogleTransportOptions = {},
): Promise<string | undefined> {
  const res = await driveGet('/about?fields=user', accessToken, opts);
  const body = (await res.json().catch(() => ({}))) as { user?: { emailAddress?: unknown } };
  const email = body.user?.emailAddress;
  return typeof email === 'string' && email.length > 0 ? email : undefined;
}

/** One entry in a Drive folder listing. `mimeType` distinguishes folders
 *  (`application/vnd.google-apps.folder`) and native editor files
 *  (`application/vnd.google-apps.*`) from regular binaries. */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  iconLink?: string;
}

export interface DriveFileList {
  files: DriveFile[];
  nextPageToken?: string;
}

const DRIVE_FILE_FIELDS = 'id,name,mimeType,modifiedTime,size,iconLink';

function parseDriveFile(raw: unknown): DriveFile | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.name !== 'string' || typeof r.mimeType !== 'string') {
    return undefined;
  }
  return {
    id: r.id,
    name: r.name,
    mimeType: r.mimeType,
    ...(typeof r.modifiedTime === 'string' ? { modifiedTime: r.modifiedTime } : {}),
    ...(typeof r.size === 'string' ? { size: r.size } : {}),
    ...(typeof r.iconLink === 'string' ? { iconLink: r.iconLink } : {}),
  };
}

/**
 * List the children of a Drive folder for the in-app browser. Defaults to My
 * Drive root (`parentId = 'root'`); entries use natural alphabetical name
 * ordering. Trashed items are excluded. `pageToken` drives pagination.
 */
export async function listDriveFiles(
  params: {
    accessToken: string;
    parentId?: string | undefined;
    query?: string | undefined;
    sharedWithMe?: boolean | undefined;
    pageToken?: string | undefined;
    pageSize?: number | undefined;
  },
  opts: GoogleTransportOptions = {},
): Promise<DriveFileList> {
  const escapeQueryValue = (value: string): string =>
    value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const query = params.query?.trim();
  const parentId = params.parentId && params.parentId.length > 0 ? params.parentId : 'root';
  // A text query searches the connected account's whole Drive. Without one,
  // preserve folder browsing (defaulting to My Drive root).
  const q =
    query && query.length > 0
      ? `name contains '${escapeQueryValue(query)}' and trashed = false`
      : params.sharedWithMe === true
        ? 'sharedWithMe = true and trashed = false'
        : `'${escapeQueryValue(parentId)}' in parents and trashed = false`;
  const search = new URLSearchParams({
    q,
    fields: `nextPageToken, files(${DRIVE_FILE_FIELDS})`,
    orderBy: 'name_natural',
    pageSize: String(params.pageSize ?? 100),
    spaces: 'drive',
    // `user` covers files owned by or shared to the connected account. Keep it
    // explicit so global name search includes "Shared with me" even if Google
    // changes corpus inference for a future query shape.
    corpora: 'user',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
    ...(params.pageToken ? { pageToken: params.pageToken } : {}),
  });
  const res = await driveGet(`/files?${search.toString()}`, params.accessToken, opts);
  const body = (await res.json().catch(() => ({}))) as {
    files?: unknown;
    nextPageToken?: unknown;
  };
  const files = Array.isArray(body.files)
    ? body.files.map(parseDriveFile).filter((f): f is DriveFile => f !== undefined)
    : [];
  return {
    files,
    ...(typeof body.nextPageToken === 'string' ? { nextPageToken: body.nextPageToken } : {}),
  };
}

/** Metadata for a single file (`GET /files/:id`). */
export async function getDriveFile(
  accessToken: string,
  fileId: string,
  opts: GoogleTransportOptions = {},
): Promise<DriveFile> {
  const res = await driveGet(
    `/files/${encodeURIComponent(fileId)}?fields=${DRIVE_FILE_FIELDS}&supportsAllDrives=true`,
    accessToken,
    opts,
  );
  const file = parseDriveFile(await res.json().catch(() => ({})));
  if (file === undefined) {
    throw new GoogleDriveError('Google Drive returned malformed file metadata', 'malformed');
  }
  return file;
}

async function driveGetBytes(
  path: string,
  accessToken: string,
  opts: GoogleTransportOptions,
): Promise<Uint8Array> {
  const { doFetch, timeoutMs } = resolveTransport(opts);
  let res: GoogleHttpResponse;
  try {
    res = await doFetch(`${GOOGLE_DRIVE_API}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new GoogleDriveError('could not reach Google Drive', 'network');
  }
  if (!res.ok) {
    throw new GoogleDriveError(
      `Google Drive download failed (${String(res.status)})`,
      `http_${String(res.status)}`,
    );
  }
  const maxBytes = opts.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  const declared = Number(res.headers?.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new GoogleDriveError('Google Drive file is too large', 'too_large');
  }
  if (res.body === undefined || res.body === null)
    throw new GoogleDriveError('Google Drive returned no file body', 'malformed');
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes)
        throw new GoogleDriveError('Google Drive file is too large', 'too_large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Raw bytes of a regular (non-native) Drive file (`?alt=media`). */
export async function downloadDriveFile(
  accessToken: string,
  fileId: string,
  opts: GoogleTransportOptions = {},
): Promise<Uint8Array> {
  return driveGetBytes(
    `/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    accessToken,
    opts,
  );
}

/** Export a native Google editor file to a concrete format (`/files/:id/export`). */
export async function exportDriveFile(
  accessToken: string,
  fileId: string,
  exportMimeType: string,
  opts: GoogleTransportOptions = {},
): Promise<Uint8Array> {
  return driveGetBytes(
    `/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMimeType)}`,
    accessToken,
    opts,
  );
}

/** How a given Drive file should be pulled into the repo: either a raw download
 *  or an export to a concrete format, plus the target file extension (no dot). */
export interface DriveImportPlan {
  kind: 'download' | 'export';
  exportMimeType?: string;
  extension: string;
}

const GOOGLE_APPS_PREFIX = 'application/vnd.google-apps.';

/** Text-first export targets for native Google editor types (ADR 0009). */
const NATIVE_EXPORT: Record<string, { mimeType: string; extension: string }> = {
  document: { mimeType: 'text/markdown', extension: 'md' },
  spreadsheet: { mimeType: 'text/csv', extension: 'csv' },
  presentation: { mimeType: 'application/pdf', extension: 'pdf' },
  drawing: { mimeType: 'image/png', extension: 'png' },
};

/** Common non-native MIME → extension fallbacks, used only when the file name
 *  carries no usable extension of its own. */
const MIME_EXTENSION: Record<string, string> = {
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

function extensionFromName(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return undefined;
  const ext = name.slice(dot + 1);
  return /^[A-Za-z0-9]{1,8}$/.test(ext) ? ext.toLowerCase() : undefined;
}

/**
 * Decide how to import a Drive file from its MIME type + name. Native Google
 * editor files export to a text-first format; folders and non-exportable Google
 * types (forms, shortcuts, …) throw a `GoogleDriveError('not_importable')`.
 * Regular files download raw, taking their extension from the file name when it
 * has one, else from a MIME fallback, else `bin`.
 */
export function planDriveImport(mimeType: string, name: string): DriveImportPlan {
  if (mimeType === `${GOOGLE_APPS_PREFIX}folder`) {
    throw new GoogleDriveError('a folder cannot be imported as a document', 'not_importable');
  }
  if (mimeType.startsWith(GOOGLE_APPS_PREFIX)) {
    const kind = mimeType.slice(GOOGLE_APPS_PREFIX.length);
    const target = NATIVE_EXPORT[kind];
    if (target === undefined) {
      throw new GoogleDriveError(
        `Google ${kind} files cannot be imported as a document`,
        'not_importable',
      );
    }
    return { kind: 'export', exportMimeType: target.mimeType, extension: target.extension };
  }
  const extension = extensionFromName(name) ?? MIME_EXTENSION[mimeType] ?? 'bin';
  return { kind: 'download', extension };
}

function slugifyReferenceName(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'document';
}

/**
 * Stable target file name for an imported Drive doc: `<slug>-<fileIdHash8>.<ext>`.
 * The hash is derived from the Drive file id (not its content), so re-importing
 * the SAME file resolves to the SAME name and overwrites it — the operator's
 * "already there → re-download and overwrite" — while two different files that
 * happen to share a title never collide. Mirrors the meeting-transcript naming.
 * The `name` extension is dropped in favour of the import plan's `extension`.
 */
export function referenceDocFileName(driveName: string, extension: string, fileId: string): string {
  const dot = driveName.lastIndexOf('.');
  const base = dot > 0 ? driveName.slice(0, dot) : driveName;
  const hash8 = createHash('sha256').update(fileId).digest('hex').slice(0, 8);
  return `${slugifyReferenceName(base)}-${hash8}.${extension}`;
}

/**
 * A cached provider of short-lived Drive access tokens. Reads the connection
 * creds (client id + refresh token) fresh via `resolveCreds` so a reconnect is
 * picked up without a restart, then refreshes an access token and memoizes it
 * under the 1h Google lifetime (default 50min TTL). Single-flight so concurrent
 * callers share one refresh. The cache is keyed on the refresh token, so a
 * reconnect (new token) or disconnect (creds gone) invalidates it. Returns
 * undefined when not connected; swallows refresh failures to undefined (the next
 * call retries) — mirrors {@link createCachedInstallationTokenMint}.
 *
 * Assumption: Google installed-app (iOS/PKCE) refresh tokens do NOT rotate, so a
 * refreshed access token never carries a replacement refresh token to persist. If
 * refresh-token rotation is ever enabled for this client, the stored token would
 * go stale and the connection would need a reconnect — revisit this then.
 */
export function createCachedGoogleAccessToken(
  resolveCreds: () => Promise<{ clientId: string; refreshToken: string } | undefined>,
  opts: { fetch?: GoogleFetch | undefined; now?: (() => number) | undefined; ttlMs?: number } = {},
): () => Promise<string | undefined> {
  const ttlMs = opts.ttlMs ?? 50 * 60_000;
  const now = opts.now ?? ((): number => Date.now());
  let cache:
    { token: string; expiresAt: number; clientId: string; refreshToken: string } | undefined;
  const inflight = new Map<string, Promise<string | undefined>>();
  return async (): Promise<string | undefined> => {
    const creds = await resolveCreds().catch(() => undefined);
    if (creds === undefined) {
      cache = undefined;
      return undefined;
    }
    const key = `${creds.clientId}\0${creds.refreshToken}`;
    const existing = inflight.get(key);
    if (existing !== undefined) return existing;
    const operation = (async (): Promise<string | undefined> => {
      try {
        if (
          cache !== undefined &&
          cache.clientId === creds.clientId &&
          cache.refreshToken === creds.refreshToken &&
          now() < cache.expiresAt
        ) {
          return cache.token;
        }
        const tokens = await refreshGoogleAccessToken(
          { clientId: creds.clientId, refreshToken: creds.refreshToken },
          { fetch: opts.fetch },
        );
        const providerTtlMs = Math.max(0, tokens.expiresInSeconds * 1000 - 30_000);
        cache = {
          token: tokens.accessToken,
          expiresAt: now() + Math.min(ttlMs, providerTtlMs),
          clientId: creds.clientId,
          refreshToken: creds.refreshToken,
        };
        return tokens.accessToken;
      } catch {
        return undefined;
      }
    })();
    inflight.set(key, operation);
    void operation.then(() => {
      if (inflight.get(key) === operation) inflight.delete(key);
    });
    return operation;
  };
}
