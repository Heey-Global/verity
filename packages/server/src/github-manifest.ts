// GitHub App "manifest one-click" onboarding (#320, PR A — server endpoints).
//
// GitHub's manifest flow creates an App from a JSON manifest the user confirms
// in their browser, then hands Verity a one-time `code` it exchanges for the
// App's id + private key (PEM). Creation does NOT install the App, so a second
// browser round-trip drives the installation (→ installation id). Only with all
// three creds (app id + PEM + installation id) does `githubAppConfigured` flip.
//
// This module holds the unit-testable pieces: the manifest builder, an in-memory
// single-use+TTL CSRF `state` store, and the code→App conversion seam. The HTTP
// routes live in server.ts and compose these. Nothing here logs or returns the
// PEM: the conversion result carries it, but callers persist it via the sealed
// settings store and never serialize it onto the wire.
//
// Runtime note: `Date.now()` / `crypto.randomBytes` are appropriate here — this
// is the long-lived SERVER runtime, not a one-shot workflow script.

import { randomBytes } from 'node:crypto';

import type { HttpFetch } from './github.js';
import { REQUIRED_GITHUB_APP_PERMISSIONS } from './github-app-token.js';

/** The GitHub App manifest Verity submits. Webhooks are DISABLED (`hook_attributes.active:false`)
 *  because Verity is pull-based (it mints installation tokens on demand, it does
 *  not receive events). Permissions are least-privilege for what Verity does:
 *  - `checks: read` — read CI/check-run status for PR bars and merge readiness.
 *  - `actions: read` — monitor GitHub Actions workflow runs, jobs, and logs
 *    (`gh run view/watch`); `checks` alone only exposes the roll-up status. The
 *    per-project sandbox token keeps these read-only subsets plus `workflows: write`
 *    (see embedded.ts / PROJECT_GITHUB_TOKEN_PERMISSIONS).
 *  - `workflows: write` — push changes to `.github/workflows/*` files; GitHub
 *    rejects any bot push that creates or updates a workflow file without it.
 *  - `issues: write` — create issues from task-board drafts / inbox items.
 *  - `metadata: read` — mandatory baseline.
 *  - `organization_projects: write` — task management (ADR 0007) creates and manages
 *    the org-owned "Verity" Projects v2 board (create board, drafts, items, reorder).
 *    Without it every `createProjectV2`/board write is FORBIDDEN, which is exactly the
 *    onboarding gap this closes: a freshly-created App can provision its board and run
 *    the `/tasks` writes out of the box. (Existing Apps must add the permission
 *    manually + get org approval — a manifest change only affects new Apps.) */
function randomManifestNameSuffix(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join('');
}

function buildManifestName(): string {
  return `Verity-${randomManifestNameSuffix()}`;
}

export function buildManifest(base: string): Record<string, unknown> {
  const root = base.replace(/\/+$/, '');
  return {
    name: buildManifestName(),
    url: root,
    // GitHub requires hook_attributes.url even when the webhook is inactive. The
    // endpoint is intentionally inert today because Verity is pull-based.
    hook_attributes: { url: `${root}/github/webhook`, active: false },
    redirect_url: `${root}/github/app/manifest/callback`,
    setup_url: `${root}/github/app/manifest/installed`,
    setup_on_update: false,
    public: false,
    default_permissions: {
      ...REQUIRED_GITHUB_APP_PERMISSIONS,
      metadata: 'read',
    },
    default_events: [],
  };
}

/** Escape a string for safe interpolation into HTML text or a single-quoted
 *  attribute value. Covers the five characters that can break out of either an
 *  attribute or an element body — the manifest JSON is placed inside a
 *  single-quoted `value='...'` attribute, so `'` MUST be escaped too. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Single-use, TTL-bounded CSRF state store for the manifest round-trips.
 *  Issued at `start` (consumed at `callback`) AND re-issued at `callback`
 *  (consumed at `installed`) — so BOTH GitHub redirects are gated and a forged
 *  callback/installed has no side effect. It's a pure opaque token (no payload):
 *  a consumed / expired / unknown token returns false. In-memory is sufficient —
 *  the flow is a single browser session spanning a few minutes; a server restart
 *  mid-flow invalidates in-flight states (the user restarts onboarding), the safe
 *  failure direction. */
export interface ManifestStateStore {
  issueState(): string;
  consumeState(state: string): boolean;
}

export interface ManifestStateStoreOptions {
  /** Injectable clock (default `Date.now`) so TTL expiry is deterministic in tests. */
  now?: () => number;
  /** State lifetime in ms (default 15 min). */
  ttlMs?: number;
}

export function createManifestStateStore(opts: ManifestStateStoreOptions = {}): ManifestStateStore {
  const now = opts.now ?? ((): number => Date.now());
  const ttlMs = opts.ttlMs ?? 15 * 60 * 1000;
  const entries = new Map<string, { createdAt: number }>();

  return {
    issueState(): string {
      const token = randomBytes(32).toString('base64url');
      entries.set(token, { createdAt: now() });
      return token;
    },
    consumeState(state: string): boolean {
      const entry = entries.get(state);
      if (entry === undefined) return false;
      // Single-use: delete before the TTL check so an expired token can't be
      // probed repeatedly, and a valid token can't be replayed.
      entries.delete(state);
      return now() - entry.createdAt <= ttlMs;
    },
  };
}

/** Result of exchanging a manifest `code` for the created App. `privateKey` is
 *  the PEM — SECRET; callers store it via the sealed settings store and never
 *  put it in a response body or log. */
export interface ManifestConvertResult {
  appId: string;
  slug: string;
  privateKey: string;
}

/** Seam for the code→App conversion so tests inject a fake instead of calling
 *  GitHub. Real impl is {@link defaultManifestConvert}. */
export type ManifestConvert = (code: string) => Promise<ManifestConvertResult>;

interface GitHubManifestConversionResponse {
  id?: unknown;
  slug?: unknown;
  pem?: unknown;
}

export interface DefaultManifestConvertOptions {
  apiBaseUrl?: string;
  fetch?: HttpFetch;
  timeoutMs?: number;
}

/**
 * Real conversion: `POST https://api.github.com/app-manifests/<code>/conversions`.
 * Parses `{ id, slug, pem }` → `{ appId, slug, privateKey }`.
 *
 * Security contract (load-bearing): on a non-2xx it throws a FIXED, redaction-
 * safe message keyed on the status — it NEVER reads or includes the response
 * body (which carries the freshly-minted PEM on success and can echo request
 * detail on error) and NEVER logs the pem. The success PEM is returned to the
 * caller (which persists it sealed) but is not logged here.
 */
export function defaultManifestConvert(opts: DefaultManifestConvertOptions = {}): ManifestConvert {
  const doFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const apiBaseUrl = (opts.apiBaseUrl ?? 'https://api.github.com').replace(/\/+$/, '');

  return async (code: string): Promise<ManifestConvertResult> => {
    const url = `${apiBaseUrl}/app-manifests/${encodeURIComponent(code)}/conversions`;
    let res;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'verity',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Network / timeout / abort — never includes the code or any credential.
      throw new Error('could not reach GitHub to convert the App manifest');
    }
    if (!res.ok) {
      // Deliberately does NOT read the body (it can carry the PEM on the odd 2xx
      // shape, or echo request detail on error). Fixed message keyed on status.
      throw new Error(`GitHub rejected the App manifest conversion (HTTP ${String(res.status)})`);
    }
    const body = (await res.json()) as GitHubManifestConversionResponse;
    const { id, slug, pem } = body;
    if (
      (typeof id !== 'string' && typeof id !== 'number') ||
      typeof slug !== 'string' ||
      slug.length === 0 ||
      typeof pem !== 'string' ||
      pem.length === 0
    ) {
      // Redaction-safe: does not echo the (partial) body, which may hold the pem.
      throw new Error('GitHub returned an unexpected App manifest conversion response');
    }
    return { appId: String(id), slug, privateKey: pem };
  };
}
