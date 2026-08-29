import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { LOCAL_PROJECT_OWNER, type ProjectRecord } from '@verity/store';
import type { HttpFetch } from './github.js';

/** Result of a live GitHub-App credential validation (`POST /github/app/validate`).
 *  On success it MAY carry SAFE, non-secret confirmation (the installation's
 *  account login) so the UI can echo "connected to @acme". It NEVER carries the
 *  minted token, the JWT, or the PEM — the failure `error` is a fixed, redacted
 *  message, never a GitHub response body (those can echo the signed JWT). */
export interface GitHubAppValidateResult {
  ok: boolean;
  /** SAFE confirmation on success: the installation account login (e.g. an org or
   *  user handle). Absent when GitHub omits it. Never a token/PEM. */
  accountLogin?: string;
  /** Redacted, human-readable failure reason on `ok === false`. Fixed messages
   *  only — never a raw GitHub body. */
  error?: string;
}

interface GitHubInstallationTokenAccount {
  login?: unknown;
}
interface GitHubInstallationTokenResponse {
  token?: unknown;
  account?: GitHubInstallationTokenAccount | null;
}

interface GitHubAppTokenResponse {
  token?: unknown;
}

/** Resolved GitHub App credentials for one mint call: the App id, the private
 *  key CONTENT (PEM), and the installation to mint against. */
export interface GitHubAppCreds {
  appId: string;
  privateKey: string;
  installationId: string;
}

export interface GitHubAppProjectTokenMintOptions {
  /** Static fallback creds from deployment config (file-based private key).
   *  Optional when {@link GitHubAppProjectTokenMintOptions.resolveCreds} is set. */
  appId?: string | undefined;
  privateKeyPath?: string | undefined;
  defaultInstallationId?: string | undefined;
  /** Preferred per-call creds source (e.g. the encrypted DB settings). Read
   *  fresh on every call so a rotated key or a re-configured App is picked up
   *  without a server restart. Returns undefined to defer to the static
   *  file-based fallback above. */
  resolveCreds?: (() => Promise<GitHubAppCreds | undefined>) | undefined;
  /** Optional least-privilege permission subset for the minted token (GitHub App
   *  installation-token `permissions` body param, e.g.
   *  `{ organization_projects: 'write', issues: 'write' }`). Each requested
   *  permission must be within what the installation was granted. Omit → the token
   *  inherits the FULL granted installation permission set (the default). GitHub
   *  always adds `metadata: read` regardless. Used to scope the task-engine token
   *  (ADR 0007) to only what it needs instead of the broad shared token. Values are
   *  GitHub's fixed access levels — a typo'd level is a compile error, not a runtime
   *  422 that would surface as a 500. */
  permissions?: Record<string, 'read' | 'write' | 'admin'> | undefined;
  apiBaseUrl?: string | undefined;
  fetch?: HttpFetch | undefined;
  readFile?: ((path: string) => string) | undefined;
  now?: (() => number) | undefined;
  timeoutMs?: number | undefined;
}

/** `kind` is OPTIONAL because two callers hold only a repo coordinate, not a
 *  project row: the gh-token broker endpoint mints from the capability binding
 *  (`{owner, repo}`), and the memo wrapper keys on the same pair. Both are still
 *  covered by the reserved-owner half of the local-project check below. */
export type GitHubProjectTokenMint = (
  project: Pick<ProjectRecord, 'owner' | 'repo'> & Partial<Pick<ProjectRecord, 'kind'>>,
) => Promise<string | undefined>;

export type GitHubInstallationTokenMint = () => Promise<string | undefined>;

export const PROJECT_GITHUB_TOKEN_PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
  checks: 'read',
  // Monitor Actions workflow runs/jobs/logs (`gh run view/watch`) — read-only;
  // re-running/cancelling would need `actions: write`, intentionally NOT granted.
  actions: 'read',
  // Push changes to `.github/workflows/*` files. GitHub refuses any bot push that
  // creates or updates a workflow file unless the token carries `workflows: write`,
  // so agents editing CI need this grant. Requires the App installation to have
  // approved the Workflows permission (else the token mint 422s — see validate()).
  workflows: 'write',
} as const satisfies Record<string, 'read' | 'write' | 'admin'>;

export const REQUIRED_GITHUB_APP_PERMISSIONS = {
  ...PROJECT_GITHUB_TOKEN_PERMISSIONS,
  organization_projects: 'write',
  issues: 'write',
} as const satisfies Record<string, 'read' | 'write' | 'admin'>;

/** Least-privilege permission set for the registry (ghcr.io) token the provisioner
 *  mints to authenticate devcontainer builds — pull the PRIVATE verity-sandbox-toolkit
 *  Feature + base image as the App. Requires the App to be granted `packages: read`. */
export const REGISTRY_GITHUB_TOKEN_PERMISSIONS = {
  packages: 'read',
} as const satisfies Record<string, 'read' | 'write' | 'admin'>;

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function createGitHubAppJwt(appId: string, privateKey: string, nowMs: number): string {
  const issuedAt = Math.floor(nowMs / 1000) - 60;
  const expiresAt = issuedAt + 540;
  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' });
  const payload = base64UrlJson({ iat: issuedAt, exp: expiresAt, iss: appId });
  const input = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256').update(input).sign(privateKey, 'base64url');
  return `${input}.${signature}`;
}

function tokenEndpoint(apiBaseUrl: string, installationId: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}/app/installations/${encodeURIComponent(
    installationId,
  )}/access_tokens`;
}

function staticGitHubAppCreds(
  opts: Pick<
    GitHubAppProjectTokenMintOptions,
    'appId' | 'privateKeyPath' | 'defaultInstallationId'
  >,
  readFile: (path: string) => string,
): GitHubAppCreds | undefined {
  return opts.appId && opts.privateKeyPath && opts.defaultInstallationId
    ? {
        appId: opts.appId,
        privateKey: readFile(opts.privateKeyPath),
        installationId: opts.defaultInstallationId,
      }
    : undefined;
}

async function mintGitHubAppInstallationToken(
  opts: GitHubAppProjectTokenMintOptions,
  body: Record<string, unknown>,
): Promise<string | undefined> {
  const doFetch = opts.fetch ?? fetch;
  const readFile = opts.readFile ?? ((path: string): string => readFileSync(path, 'utf8'));
  const now = opts.now ?? ((): number => Date.now());
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const apiBaseUrl = opts.apiBaseUrl ?? 'https://api.github.com';

  // Prefer the app-configured (DB) creds; fall back to the deployment file.
  // The static path reads the key file per call so it survives key rotation.
  const creds = (await opts.resolveCreds?.()) ?? staticGitHubAppCreds(opts, readFile);
  if (creds === undefined) return undefined;
  const jwt = createGitHubAppJwt(creds.appId, creds.privateKey, now());
  const res = await doFetch(tokenEndpoint(apiBaseUrl, creds.installationId), {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      'User-Agent': 'verity',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`GitHub App token mint failed: HTTP ${String(res.status)}`);
  }
  const payload = (await res.json()) as GitHubAppTokenResponse;
  return typeof payload.token === 'string' && payload.token.length > 0 ? payload.token : undefined;
}

/**
 * Mint short-lived GitHub App installation tokens directly inside Verity.
 * The token is scoped to the target repository name via GitHub's
 * `repositories` request body, then persisted by the provisioner into the
 * project's host clone directory for container git operations.
 */
export function createGitHubAppProjectTokenMint(
  opts: GitHubAppProjectTokenMintOptions,
): GitHubProjectTokenMint {
  return async (project): Promise<string | undefined> => {
    // A project with no GitHub repository behind it has nothing to mint against,
    // and `mintGitHubAppInstallationToken` THROWS on any GitHub non-2xx — so an
    // unguarded caller (session spawn refreshes the project token before it
    // starts) would fail outright instead of degrading. This is the single choke
    // point for that: the provisioner's clone/fetch path, the worktree factory
    // and the token-refresh path all mint through here.
    if (
      project.kind === 'local' ||
      project.kind === 'control_plane' ||
      project.owner === LOCAL_PROJECT_OWNER
    )
      return undefined;
    return mintGitHubAppInstallationToken(opts, {
      repositories: [project.repo],
      // Only include the subset when configured — an absent `permissions` key
      // keeps the full-installation-scope behaviour (and the existing wire shape).
      ...(opts.permissions ? { permissions: opts.permissions } : {}),
    });
  };
}

/**
 * Mint an installation-level token without a `repositories` filter. This is still
 * permission-bounded by GitHub's `permissions` subset, but it can resolve issue
 * content from every repository the App installation can access. The task board
 * needs that for cross-repo ProjectV2 items: a board item can point at an issue
 * in any installed repo, and GitHub omits inaccessible content from the read.
 */
export function createGitHubAppInstallationTokenMint(
  opts: GitHubAppProjectTokenMintOptions,
): GitHubInstallationTokenMint {
  return (): Promise<string | undefined> =>
    mintGitHubAppInstallationToken(opts, {
      ...(opts.permissions ? { permissions: opts.permissions } : {}),
    });
}

/**
 * Wrap a {@link GitHubProjectTokenMint} with a per-`owner/repo` TTL memo + single-flight
 * so repeated callers don't re-mint on every call. The reuse consumers — the task board's
 * per-operation preflight and the release lookup's refreshes — would otherwise mint a
 * fresh installation token for each read; here they share one cached token per repo.
 *
 * Caches only a SUCCESSFUL (defined) token per key for `ttlMs` (default 50min, under the
 * 1h installation-token life). An undefined result — AND a thrown mint (the mint throws on
 * any GitHub non-2xx: a 422 when the requested permission subset exceeds the installation
 * grant, a transient 5xx, an expired/revoked key) — degrades to undefined and is NOT
 * cached, so the next call retries. Swallowing the throw keeps the consumers' documented
 * "never throws" contract intact.
 *
 * Single-flight: concurrent callers for the SAME key share one in-flight mint rather than
 * each firing their own (no thundering herd at startup or a TTL boundary).
 *
 * NOT for the provisioner / worktree paths: those write the token into a project's
 * `.gh-token` file that must stay valid for ~1h, so they need a FRESH mint each time and
 * keep using the raw {@link GitHubProjectTokenMint}.
 */
export function createCachedProjectTokenMint(
  mint: GitHubProjectTokenMint,
  opts: { ttlMs?: number | undefined; now?: (() => number) | undefined } = {},
): GitHubProjectTokenMint {
  const ttlMs = opts.ttlMs ?? 50 * 60_000;
  const now = opts.now ?? ((): number => Date.now());
  const cache = new Map<string, { token: string; at: number }>();
  const inflight = new Map<string, Promise<string | undefined>>();
  return (project): Promise<string | undefined> => {
    const key = `${project.owner}/${project.repo}`;
    const hit = cache.get(key);
    if (hit !== undefined && now() - hit.at < ttlMs) return Promise.resolve(hit.token);
    const existing = inflight.get(key);
    if (existing !== undefined) return existing;
    const pending = (async (): Promise<string | undefined> => {
      try {
        const token = await mint(project);
        if (token !== undefined) cache.set(key, { token, at: now() });
        return token;
      } catch {
        return undefined; // never cached → the next call retries
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, pending);
    return pending;
  };
}

export function createCachedInstallationTokenMint(
  mint: GitHubInstallationTokenMint,
  opts: { ttlMs?: number | undefined; now?: (() => number) | undefined } = {},
): GitHubInstallationTokenMint {
  const ttlMs = opts.ttlMs ?? 50 * 60_000;
  const now = opts.now ?? ((): number => Date.now());
  let cache: { token: string; at: number } | undefined;
  let inflight: Promise<string | undefined> | undefined;
  return (): Promise<string | undefined> => {
    if (cache !== undefined && now() - cache.at < ttlMs) return Promise.resolve(cache.token);
    if (inflight !== undefined) return inflight;
    inflight = (async (): Promise<string | undefined> => {
      try {
        const token = await mint();
        if (token !== undefined) cache = { token, at: now() };
        return token;
      } catch {
        return undefined;
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  };
}

/** Options for {@link validateGitHubAppCreds} — the same fetch/now/timeout seams as
 *  the mint so tests can inject a fake transport and clock. */
export interface GitHubAppValidateOptions {
  apiBaseUrl?: string | undefined;
  fetch?: HttpFetch | undefined;
  now?: (() => number) | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Live "do these GitHub-App credentials actually work" check: sign an App JWT with
 * the given PEM and mint an INSTALLATION-level access token with the required
 * App permissions. A `201` with a non-empty token proves the App id +
 * PEM + installation id all line up on GitHub's side AND that the installation
 * has approved the permissions Verity will request for project/session tokens.
 *
 * Security contract (load-bearing — the whole point of running this server-side):
 * this function NEVER returns, throws, or logs the minted token, the signing JWT,
 * or the PEM. On failure it maps to a FIXED, redacted message keyed on the HTTP
 * status (or a generic transport message) — GitHub error bodies are NOT surfaced
 * because a malformed-JWT 401 body can echo the JWT back. The only value it lifts
 * out of the success body is the installation's account `login`, a public handle.
 */
export async function validateGitHubAppCreds(
  creds: GitHubAppCreds,
  opts: GitHubAppValidateOptions = {},
): Promise<GitHubAppValidateResult> {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? ((): number => Date.now());
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const apiBaseUrl = opts.apiBaseUrl ?? 'https://api.github.com';

  let jwt: string;
  try {
    // A bad PEM (not a private key) throws here — surface a fixed message, never
    // the underlying crypto error (which can quote key material).
    jwt = createGitHubAppJwt(creds.appId, creds.privateKey, now());
  } catch {
    return { ok: false, error: 'invalid private key' };
  }

  let res;
  try {
    res = await doFetch(tokenEndpoint(apiBaseUrl, creds.installationId), {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        'User-Agent': 'verity',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      // No `repositories` → an installation-level token (validation only; never
      // persisted or returned). Request the full App permission subset Verity
      // needs so existing Apps missing a newly-required grant fail validation
      // before provisioning/session/task token refresh starts failing later.
      body: JSON.stringify({ permissions: REQUIRED_GITHUB_APP_PERMISSIONS }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Network / timeout / abort — never includes credentials.
    return { ok: false, error: 'could not reach GitHub' };
  }

  if (!res.ok) {
    // Map status → fixed message. Deliberately does NOT read `res.json()`/`text()`
    // (the body can echo the JWT). 401/403 = bad App id / PEM mismatch; 404 =
    // wrong installation id; 422 = requested permissions exceed the installation
    // grant and the App needs a permissions update; other = generic upstream
    // failure.
    const error =
      res.status === 401 || res.status === 403
        ? 'GitHub rejected the App credentials (check the App ID and private key)'
        : res.status === 404
          ? 'installation not found (check the Installation ID)'
          : res.status === 422
            ? 'GitHub App is missing required permissions (approve Contents, Pull requests, Checks, Workflows, Issues, and Organization projects)'
            : `GitHub returned an unexpected status (${String(res.status)})`;
    return { ok: false, error };
  }

  const body = (await res.json()) as GitHubInstallationTokenResponse;
  if (typeof body.token !== 'string' || body.token.length === 0) {
    return { ok: false, error: 'GitHub did not return a token' };
  }
  const login = body.account?.login;
  return {
    ok: true,
    ...(typeof login === 'string' && login.length > 0 ? { accountLogin: login } : {}),
  };
}

/** The account a GitHub App installation belongs to (`GET /app/installations/:id`
 *  → `account`). `id`+`login`+`type` are the public identity fields we derive the
 *  git committer identity from. */
interface GitHubInstallationAccount {
  login?: unknown;
  id?: unknown;
  type?: unknown;
}
interface GitHubInstallationResponse {
  account?: GitHubInstallationAccount | null;
}

function installationEndpoint(apiBaseUrl: string, installationId: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}/app/installations/${encodeURIComponent(
    installationId,
  )}`;
}

/** Resolved git committer identity for the App's installation account. `name` is
 *  the account login; `email` is GitHub's canonical no-reply address for that
 *  account (`<id>+<login>@users.noreply.github.com`), which is always a verified
 *  email of the account — so commits carrying it verify against a signing key
 *  registered on that same account. */
export interface GitHubAppIdentityResult {
  ok: boolean;
  name?: string;
  email?: string;
  /** Redacted failure reason on `ok === false`. Fixed messages only. */
  error?: string;
}

/**
 * Derive the git committer identity (name + email) from a GitHub App's
 * installation — so `VERITY_GIT_USER_NAME`/`VERITY_GIT_USER_EMAIL` need not be
 * configured. Signs an App JWT and reads `GET /app/installations/:id` for the
 * account the App is installed on.
 *
 * Only a **user** installation yields a signing identity: SSH signing keys are
 * registered on user accounts, so a commit must carry a user's (no-reply) email
 * to verify. An **organization** installation has no signing-key slot, so it is
 * rejected with a clear error rather than producing an un-verifiable identity.
 *
 * Security contract mirrors {@link validateGitHubAppCreds}: never returns/throws/
 * logs the JWT or PEM; failures map to fixed, status-keyed messages and never
 * echo a GitHub error body. The only values lifted from a success body are the
 * account's public `login`/`id`/`type`.
 */
export async function resolveGitHubAppIdentity(
  creds: GitHubAppCreds,
  opts: GitHubAppValidateOptions = {},
): Promise<GitHubAppIdentityResult> {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? ((): number => Date.now());
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const apiBaseUrl = opts.apiBaseUrl ?? 'https://api.github.com';

  let jwt: string;
  try {
    jwt = createGitHubAppJwt(creds.appId, creds.privateKey, now());
  } catch {
    return { ok: false, error: 'invalid private key' };
  }

  let res;
  try {
    res = await doFetch(installationEndpoint(apiBaseUrl, creds.installationId), {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'User-Agent': 'verity',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, error: 'could not reach GitHub' };
  }

  if (!res.ok) {
    const error =
      res.status === 401 || res.status === 403
        ? 'GitHub rejected the App credentials (check the App ID and private key)'
        : res.status === 404
          ? 'installation not found (check the Installation ID)'
          : `GitHub returned an unexpected status (${String(res.status)})`;
    return { ok: false, error };
  }

  const body = (await res.json()) as GitHubInstallationResponse;
  const login = body.account?.login;
  const id = body.account?.id;
  const type = body.account?.type;
  if (typeof login !== 'string' || login.length === 0 || typeof id !== 'number') {
    return { ok: false, error: 'GitHub did not return the installation account' };
  }
  if (type !== 'User') {
    return {
      ok: false,
      error:
        'the GitHub App is installed on an organization; commit-signing identity can only ' +
        'be derived from a user installation (SSH signing keys belong to user accounts)',
    };
  }
  return {
    ok: true,
    name: login,
    email: `${String(id)}+${login}@users.noreply.github.com`,
  };
}
