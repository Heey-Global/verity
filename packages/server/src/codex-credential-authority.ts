import { CodexCredentialUnavailableError } from './codex-sign-in-error.js';

const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_REFRESH_URL = 'https://auth.openai.com/oauth/token';
const REFRESH_WINDOW_MS = 5 * 60_000;
const FALLBACK_REFRESH_AGE_MS = 8 * 24 * 60 * 60_000;
// Bounds the request AND the body read that follows it, on both the success and
// the failure path. Everything here runs inside `exclusive()`, so a token
// endpoint that accepts the connection and then stops talking would otherwise
// hold the single-writer lock for as long as it cared to, and every Codex egress
// request and usage probe behind it waits there.
const REFRESH_REQUEST_TIMEOUT_MS = 20_000;

interface CodexTokenData extends Record<string, unknown> {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  account_id?: string;
}

interface CodexAuthDocument extends Record<string, unknown> {
  tokens: CodexTokenData;
  last_refresh?: string;
}

export interface CodexGatewayCredential {
  accessToken: string;
  accountId: string;
}

interface CodexRefreshResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
}

/**
 * Single-writer authority for Codex subscription OAuth credentials.
 *
 * The caller supplies durable persistence. A rotated refresh token is committed
 * there before the in-memory credential changes, so a process crash cannot
 * leave the only valid token in volatile memory.
 */
export class CodexCredentialAuthority {
  private document: CodexAuthDocument;
  private serialized: Promise<void> = Promise.resolve();

  constructor(
    authJson: string,
    private readonly options: {
      persist: (authJson: string) => Promise<void>;
      refresh?: (refreshToken: string) => Promise<CodexRefreshResponse>;
      now?: () => number;
    },
  ) {
    this.document = parseCodexAuthJson(authJson);
  }

  resolve(): Promise<CodexGatewayCredential> {
    return this.exclusive(async () => {
      const refreshed = shouldRefresh(this.document, this.options.now?.() ?? Date.now());
      if (refreshed) {
        await this.refresh();
      }
      // Whether an unusable document is the LOGIN's fault turns on where it came
      // from. Untouched, it is the login as installed and a new sign-in replaces
      // it. Rewritten by a refresh a moment ago, the same defect is the token
      // endpoint having answered in a shape this Server cannot use — which is the
      // classification `refreshCodexToken` already gives its own half of that
      // answer, and which signing in again would not change.
      return credentialFrom(this.document, !refreshed);
    });
  }

  refreshAfterUnauthorized(previousAccessToken: string): Promise<CodexGatewayCredential> {
    return this.exclusive(async () => {
      // Several in-flight requests can observe the same 401. Only the first may
      // redeem the single-use rotating refresh token; later callers reuse it.
      if (this.document.tokens.access_token !== previousAccessToken) {
        // Refreshed by the caller ahead of this one, so still not the login's fault.
        return credentialFrom(this.document, false);
      }
      await this.refresh();
      return credentialFrom(this.document, false);
    });
  }

  snapshot(): string {
    return `${JSON.stringify(this.document)}\n`;
  }

  private async refresh(): Promise<void> {
    const response = await (this.options.refresh ?? refreshCodexToken)(
      this.document.tokens.refresh_token,
    );
    if (typeof response.access_token !== 'string' || response.access_token.length === 0) {
      throw new CodexCredentialUnavailableError(
        'Codex OAuth refresh did not return an access token',
      );
    }
    const next: CodexAuthDocument = {
      ...this.document,
      tokens: {
        ...this.document.tokens,
        access_token: response.access_token,
        ...(typeof response.refresh_token === 'string' && response.refresh_token.length > 0
          ? { refresh_token: response.refresh_token }
          : {}),
        ...(typeof response.id_token === 'string' && response.id_token.length > 0
          ? { id_token: response.id_token }
          : {}),
      },
      last_refresh: new Date(this.options.now?.() ?? Date.now()).toISOString(),
    };
    // Write-ahead: rotating refresh tokens are single-use.
    await this.options.persist(`${JSON.stringify(next)}\n`);
    this.document = next;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serialized.then(operation, operation);
    this.serialized = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * `signInRejected` here is about the material, not about a live refusal: what
 * fails these checks is a login a new sign-in overwrites, so the flag is right on
 * its own terms. Note where it lands, though — this runs from the constructor, so
 * on the CONFIGURE path it fails that request and leaves the gateway with no Codex
 * authority at all, which the token read then reports as "no login installed"
 * rather than as a refusal. What does reach the operator as one is the stored
 * login failing later, at `resolve()`: either the refresh being turned down, or a
 * document that never needed refreshing and cannot be read (see `credentialFrom`).
 */
export function parseCodexAuthJson(authJson: string): CodexAuthDocument {
  let value: unknown;
  try {
    value = JSON.parse(authJson);
  } catch {
    throw new CodexCredentialUnavailableError('Codex auth JSON is invalid', {
      signInRejected: true,
    });
  }
  if (!isRecord(value) || !isRecord(value.tokens)) {
    throw new CodexCredentialUnavailableError('Codex auth JSON has no token bundle', {
      signInRejected: true,
    });
  }
  const tokens = value.tokens;
  if (
    typeof tokens.access_token !== 'string' ||
    tokens.access_token.length === 0 ||
    typeof tokens.refresh_token !== 'string' ||
    tokens.refresh_token.length === 0 ||
    /[\r\n]/u.test(tokens.access_token) ||
    /[\r\n]/u.test(tokens.refresh_token)
  ) {
    throw new CodexCredentialUnavailableError('Codex auth JSON token bundle is invalid', {
      signInRejected: true,
    });
  }
  return value as CodexAuthDocument;
}

function credentialFrom(
  document: CodexAuthDocument,
  signInRejected: boolean,
): CodexGatewayCredential {
  const accountId =
    nonEmpty(document.tokens.account_id) ??
    jwtClaim(document.tokens.access_token, 'chatgpt_account_id') ??
    (typeof document.tokens.id_token === 'string'
      ? jwtClaim(document.tokens.id_token, 'chatgpt_account_id')
      : undefined);
  if (accountId === undefined || /[\r\n]/u.test(accountId)) {
    throw new CodexCredentialUnavailableError('Codex auth JSON has no account id', {
      signInRejected,
    });
  }
  return { accessToken: document.tokens.access_token, accountId };
}

function shouldRefresh(document: CodexAuthDocument, now: number): boolean {
  const expiresAt = jwtNumericClaim(document.tokens.access_token, 'exp');
  if (expiresAt !== undefined) return expiresAt * 1_000 <= now + REFRESH_WINDOW_MS;
  const lastRefresh = Date.parse(document.last_refresh ?? '');
  return Number.isFinite(lastRefresh) && lastRefresh <= now - FALLBACK_REFRESH_AGE_MS;
}

async function refreshCodexToken(refreshToken: string): Promise<CodexRefreshResponse> {
  let response: Response;
  try {
    response = await fetch(CODEX_REFRESH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: CODEX_OAUTH_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(REFRESH_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CodexCredentialUnavailableError('Codex OAuth refresh is unavailable', {
      cause: error,
    });
  }
  if (!response.ok) {
    // Reached, but no token. Only ONE answer means the stored refresh token itself
    // is gone — revoked, expired, or superseded by a sign-in elsewhere — and only
    // that one is worth offering a re-login for. A 429 or a 5xx is the endpoint
    // having a bad minute with the same token still good, and the rest of the 400s
    // are this client asking wrongly; either way a re-login fixes nothing, and a
    // button that fixes nothing is worse than no button.
    const rejected = await isGrantRefusal(response);
    throw new CodexCredentialUnavailableError(
      rejected
        ? 'Codex OAuth refresh was rejected'
        : `Codex OAuth refresh failed with status ${response.status}`,
      { signInRejected: rejected },
    );
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    // A 200 whose body never arrives, or arrives as something other than JSON.
    // Caught so a timed-out body read leaves this function the same way every
    // other refresh failure does, rather than as a bare `AbortError` no caller
    // classifies.
    throw new CodexCredentialUnavailableError('Codex OAuth refresh response is invalid', {
      cause: error,
    });
  }
  if (!isRecord(value)) {
    throw new CodexCredentialUnavailableError('Codex OAuth refresh response is invalid');
  }
  return {
    ...(typeof value.access_token === 'string' ? { access_token: value.access_token } : {}),
    ...(typeof value.refresh_token === 'string' ? { refresh_token: value.refresh_token } : {}),
    ...(typeof value.id_token === 'string' ? { id_token: value.id_token } : {}),
  };
}

/**
 * Whether this failed token response says the stored GRANT is what was refused.
 *
 * The status alone cannot say so: RFC 6749 answers `invalid_grant` with 400, but
 * it answers `invalid_request`, `invalid_client` and `unsupported_grant_type`
 * with 400 too, and those are this client asking wrongly with a login that is
 * still perfectly good. So the body's `error` code is the discriminator, and
 * anything else — an unreadable body, a 403 policy block, a 429, a 5xx — is read
 * as not the login's fault. Erring that way costs a banner that stays silent; the
 * other way costs an operator a sign-in that changes nothing.
 *
 * A body that never finishes arriving reads the same way, because the deadline on
 * the request covers it: `REFRESH_REQUEST_TIMEOUT_MS` firing mid-read lands in the
 * catch below as "cannot say", and cannot-say is the same answer as not-the-login.
 * A genuine `invalid_grant` behind a 20-second silence therefore costs a banner
 * that stays quiet for one more probe — the failure is continuous, so the next
 * attempt reclassifies it — where the other reading would offer a re-login for
 * every slow response the endpoint ever gives.
 *
 * Reading the body also drains it, which the throw path would otherwise leave to
 * the garbage collector to release along with its connection.
 */
async function isGrantRefusal(response: Response): Promise<boolean> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return false;
  }
  return isRecord(body) && body.error === 'invalid_grant';
}

function jwtClaim(token: string, claim: string): string | undefined {
  const value = jwtPayload(token)?.[claim];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function jwtNumericClaim(token: string, claim: string): number | undefined {
  const value = jwtPayload(token)?.[claim];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function jwtPayload(token: string): Record<string, unknown> | undefined {
  const encoded = token.split('.')[1];
  if (encoded === undefined) return undefined;
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
