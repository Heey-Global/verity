import type { HttpFetch } from './github.js';

/** Result of a live Doppler Service Account token validation (`POST /doppler/validate`,
 *  #320). On success it MAY carry a SAFE, non-secret confirmation (the number of
 *  projects the token can list) so the UI can echo "connected (N projects)". It
 *  NEVER carries the token or any Doppler response body — the failure `error` is a
 *  fixed, redacted message, never a raw Doppler body (those can echo request
 *  context). */
export interface DopplerValidateResult {
  ok: boolean;
  /** SAFE confirmation on success: how many projects the token can list, summed
   *  across every page Doppler returns. Absent when Doppler omits a countable list
   *  or the walk past the first page could not be completed — a missing count is
   *  never a validation failure. Never the token. */
  projectCount?: number;
  /** Redacted, human-readable failure reason on `ok === false`. Fixed messages
   *  only — never a raw Doppler body. */
  error?: string;
}

interface DopplerProjectsResponse {
  projects?: unknown;
}

/** Options for {@link validateDopplerToken} — the same fetch/timeout seams as the
 *  GitHub validator so tests can inject a fake transport. */
export interface DopplerValidateOptions {
  apiBaseUrl?: string | undefined;
  fetch?: HttpFetch | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Live "does this Doppler Service Account token actually work" check: list the
 * account's projects (`GET /v3/projects`) with the token as a Bearer credential.
 * A `200` on the FIRST page proves the token is valid and account-scoped; the
 * project list length is lifted out as a SAFE confirmation count.
 *
 * The endpoint is paginated (see {@link DOPPLER_PAGE_SIZE}), so a full first page
 * means there is more to count and the walk continues. That continuation is
 * best-effort: validity is already established, so a later page that fails drops
 * the count rather than reporting a working token as broken.
 *
 * Security contract (load-bearing — the whole point of running this server-side):
 * this function NEVER returns, throws, or logs the token, and NEVER reads/echoes
 * the Doppler response body on failure. On failure it maps to a FIXED, redacted
 * message keyed on the HTTP status (or a generic transport message) — a 401/403
 * both mean "Doppler rejected the token". The only value it lifts out of a success
 * body is the project count (a non-secret integer).
 */
export async function validateDopplerToken(
  token: string,
  opts: DopplerValidateOptions = {},
): Promise<DopplerValidateResult> {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const apiBaseUrl = opts.apiBaseUrl ?? 'https://api.doppler.com';
  const url = `${apiBaseUrl.replace(/\/+$/, '')}/v3/projects`;
  const deadline = Date.now() + timeoutMs;

  let res;
  try {
    res = await doFetch(withDopplerPage(url, 1), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'verity',
      },
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
  } catch {
    // Network / timeout / abort — never includes the token.
    return { ok: false, error: 'could not reach Doppler' };
  }

  if (!res.ok) {
    // Map status → fixed message. Deliberately does NOT read `res.json()`/`text()`
    // (the body can echo request context). 401/403 = the token is rejected; other
    // = a generic upstream failure.
    const error =
      res.status === 401 || res.status === 403
        ? 'Doppler rejected the token'
        : `Doppler returned an unexpected status (${String(res.status)})`;
    return { ok: false, error };
  }

  // Success: lift ONLY the project count (a safe integer) from the body. Any parse
  // failure degrades to a token-less success without a count — never surfaces the
  // body.
  let projectCount: number | undefined;
  try {
    const body = (await res.json()) as DopplerProjectsResponse;
    if (Array.isArray(body.projects)) projectCount = body.projects.length;
  } catch {
    projectCount = undefined;
  }
  // A full first page means Doppler has more to hand out, and the count would
  // otherwise stick at the page size — "connected (100 projects)" for an account
  // with 400. Sum the rest.
  if (projectCount === DOPPLER_PAGE_SIZE) {
    projectCount = await countRemainingDopplerProjects(token, opts, url, projectCount, deadline);
  }
  return { ok: true, ...(projectCount !== undefined ? { projectCount } : {}) };
}

/** A single Doppler project as surfaced to the binding picker (#320). `slug` is the
 *  stable identifier minting uses as its `project` argument; `name` is the display
 *  label. NON-secret — safe to send to the client. */
export interface DopplerProjectSummary {
  slug: string;
  name: string;
}

/** A single Doppler config within a project, as surfaced to the binding picker
 *  (#320). `name` is what minting uses as its `config` argument; `environment` /
 *  `root` are included so the UI can group root configs vs branch/sub configs
 *  later (deferred). NON-secret. */
export interface DopplerConfigSummary {
  name: string;
  environment?: string;
  root?: boolean;
}

interface DopplerConfigsResponse {
  configs?: unknown;
}

/** Map a raw Doppler `GET /v3/projects` body to the picker's project summaries.
 *  Skips malformed entries (missing `slug`/`name`) rather than throwing, so one
 *  odd row can't blank the whole list. NEVER touches secret material. */
function mapDopplerProjects(body: DopplerProjectsResponse): DopplerProjectSummary[] {
  if (!Array.isArray(body.projects)) return [];
  const projects: DopplerProjectSummary[] = [];
  for (const entry of body.projects) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as { slug?: unknown; name?: unknown; id?: unknown };
    // Doppler returns `slug` (its stable identifier) and `name`; older shapes used
    // `id` as the slug. Prefer `slug`, fall back to `id`, then to `name`.
    const slug =
      typeof record.slug === 'string' && record.slug.length > 0
        ? record.slug
        : typeof record.id === 'string' && record.id.length > 0
          ? record.id
          : typeof record.name === 'string'
            ? record.name
            : undefined;
    if (slug === undefined || slug.length === 0) continue;
    const name = typeof record.name === 'string' && record.name.length > 0 ? record.name : slug;
    projects.push({ slug, name });
  }
  return projects;
}

/** Map a raw Doppler `GET /v3/configs` body to the picker's config summaries.
 *  Skips malformed entries (missing `name`). NEVER touches secret material. */
function mapDopplerConfigs(body: DopplerConfigsResponse): DopplerConfigSummary[] {
  if (!Array.isArray(body.configs)) return [];
  const configs: DopplerConfigSummary[] = [];
  for (const entry of body.configs) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as { name?: unknown; environment?: unknown; root?: unknown };
    if (typeof record.name !== 'string' || record.name.length === 0) continue;
    configs.push({
      name: record.name,
      ...(typeof record.environment === 'string' ? { environment: record.environment } : {}),
      ...(typeof record.root === 'boolean' ? { root: record.root } : {}),
    });
  }
  return configs;
}

/**
 * Map an HTTP status to a fixed, redacted error message and throw it. Shared by
 * the two list helpers so their failure paths are identical and NEVER echo the
 * Doppler response body (which can carry request context) or the token. A
 * 401/403 both mean "Doppler rejected the token"; anything else is a generic
 * upstream failure.
 */
function throwRedactedDopplerError(status: number): never {
  throw new Error(
    status === 401 || status === 403
      ? 'Doppler rejected the token'
      : `Doppler returned an unexpected status (${String(status)})`,
  );
}

/** Doppler paginates its list endpoints and defaults to 20 items per page, so a
 *  single un-paged request silently truncates every account with more projects
 *  (or configs) than that — the entries never appear in the picker no matter what
 *  the token is allowed to see. Ask for a larger page and walk until a page comes
 *  back short. `DOPPLER_MAX_PAGES` is the explicit supported safety ceiling: a
 *  probe after 100 full pages confirms exact-boundary exhaustion, while any
 *  additional entry fails closed instead of returning a silently truncated list. */
const DOPPLER_PAGE_SIZE = 100;
const DOPPLER_MAX_PAGES = 100;

/** Append Doppler's pagination query to a list URL that may already carry one. */
function withDopplerPage(url: string, page: number): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}page=${String(page)}&per_page=${String(DOPPLER_PAGE_SIZE)}`;
}

/**
 * Walk a paginated Doppler list endpoint and concatenate the mapped entries.
 * Shared by the two list helpers below so their transport, redaction, and stop
 * condition stay identical.
 *
 * The stop condition counts the RAW entries Doppler returned, not the mapped
 * ones: `mapDopplerProjects`/`mapDopplerConfigs` deliberately skip malformed
 * rows, so a full page containing one bad row would otherwise look short and
 * truncate the walk.
 *
 * Same security contract as its callers: NEVER returns, throws, or logs the
 * token, and NEVER echoes a Doppler response body — a non-2xx on ANY page throws
 * the fixed, status-keyed message. Each page is bounded by the remaining share
 * of one overall pagination timeout, preventing a slow upstream from multiplying
 * the request budget by the page limit.
 */
async function listDopplerPaged<T>(
  token: string,
  opts: DopplerValidateOptions,
  buildUrl: (apiBaseUrl: string) => string,
  readPage: (body: unknown) => { valid: boolean; rawCount: number; items: T[] },
): Promise<T[]> {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const apiBaseUrl = (opts.apiBaseUrl ?? 'https://api.doppler.com').replace(/\/+$/, '');
  const baseUrl = buildUrl(apiBaseUrl);
  const deadline = Date.now() + timeoutMs;

  const items: T[] = [];
  for (let page = 1; page <= DOPPLER_MAX_PAGES + 1; page += 1) {
    let res;
    try {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error('pagination deadline exceeded');
      res = await doFetch(withDopplerPage(baseUrl, page), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'verity',
        },
        signal: AbortSignal.timeout(remainingMs),
      });
    } catch {
      // Network / timeout / abort — never includes the token.
      throw new Error('could not reach Doppler');
    }

    if (!res.ok) throwRedactedDopplerError(res.status);

    let pageResult: { valid: boolean; rawCount: number; items: T[] };
    try {
      pageResult = readPage(await res.json());
    } catch {
      throw new Error('Doppler returned an invalid response');
    }
    const { valid, rawCount, items: pageItems } = pageResult;
    if (!valid) throw new Error('Doppler returned an invalid response');
    if (page > DOPPLER_MAX_PAGES) {
      if (rawCount === 0) return items;
      throw new Error('Doppler returned too many pages');
    }
    items.push(...pageItems);
    if (rawCount < DOPPLER_PAGE_SIZE) return items;
  }
  throw new Error('Doppler returned too many pages');
}

/**
 * Continue {@link validateDopplerToken}'s project count past its first page.
 * Called only when page 1 came back full, i.e. when the count would otherwise
 * report the page size instead of the account's real total.
 *
 * Deliberately best-effort, and this is why it does not reuse {@link
 * listDopplerPaged}: page 1 has already proven the token valid, so ANY problem
 * here — non-2xx, transport failure, unparseable body, or still-full pages at the
 * guard — returns `undefined`. The UI then echoes a plain "connected" instead of
 * a wrong number, and a working token is never reported as rejected because a
 * later page hiccuped. A partial sum is NOT returned: a number that is silently
 * too low reads as fact, `undefined` reads as "not counted".
 *
 * Same redaction contract as the rest of this file: never returns, throws, or
 * logs the token, and never reads a failure body.
 */
async function countRemainingDopplerProjects(
  token: string,
  opts: DopplerValidateOptions,
  url: string,
  firstPageCount: number,
  deadline: number,
): Promise<number | undefined> {
  const doFetch = opts.fetch ?? fetch;

  let total = firstPageCount;
  for (let page = 2; page <= DOPPLER_MAX_PAGES + 1; page += 1) {
    let res;
    try {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return undefined;
      res = await doFetch(withDopplerPage(url, page), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'verity',
        },
        signal: AbortSignal.timeout(remainingMs),
      });
    } catch {
      return undefined;
    }
    if (!res.ok) return undefined;

    let pageCount: number;
    try {
      const body = (await res.json()) as DopplerProjectsResponse;
      if (!Array.isArray(body.projects)) return undefined;
      pageCount = body.projects.length;
    } catch {
      return undefined;
    }

    if (page > DOPPLER_MAX_PAGES) return pageCount === 0 ? total : undefined;
    total += pageCount;
    if (pageCount < DOPPLER_PAGE_SIZE) return total;
  }
  // Still full pages at the guard — the total is unknown, not `total`.
  return undefined;
}

/**
 * List the account's Doppler projects for the binding picker (#320): `GET
 * /v3/projects` with the account token as a Bearer credential, paged until
 * Doppler returns a short page. Returns only the NON-secret `{ slug, name }`
 * summaries.
 *
 * Security contract (load-bearing — the whole point of running this server-side,
 * closing the confused-deputy: the list comes from the TRUSTED account token, not
 * repo content): this function NEVER returns, throws, or logs the token, and NEVER
 * echoes the Doppler response body on failure. On failure it throws a FIXED,
 * redacted message keyed on the HTTP status (or a generic transport message).
 */
export async function listDopplerProjects(
  token: string,
  opts: DopplerValidateOptions = {},
): Promise<DopplerProjectSummary[]> {
  return listDopplerPaged(
    token,
    opts,
    (apiBaseUrl) => `${apiBaseUrl}/v3/projects`,
    (body) => {
      const page = body as DopplerProjectsResponse;
      return {
        valid: Array.isArray(page.projects),
        rawCount: Array.isArray(page.projects) ? page.projects.length : 0,
        items: mapDopplerProjects(page),
      };
    },
  );
}

/**
 * List a Doppler project's configs for the binding picker (#320): `GET
 * /v3/configs?project=<project>` with the account token as a Bearer credential,
 * paged the same way as {@link listDopplerProjects}. Returns only the NON-secret
 * `{ name, environment?, root? }` summaries.
 *
 * Same security contract as {@link listDopplerProjects}: never returns/throws/logs
 * the token, never echoes the Doppler body on failure (redacted status-keyed
 * throw). The `project` slug is URL-encoded into the query.
 */
export async function listDopplerConfigs(
  token: string,
  project: string,
  opts: DopplerValidateOptions = {},
): Promise<DopplerConfigSummary[]> {
  return listDopplerPaged(
    token,
    opts,
    (apiBaseUrl) => `${apiBaseUrl}/v3/configs?project=${encodeURIComponent(project)}`,
    (body) => {
      const page = body as DopplerConfigsResponse;
      return {
        valid: Array.isArray(page.configs),
        rawCount: Array.isArray(page.configs) ? page.configs.length : 0,
        items: mapDopplerConfigs(page),
      };
    },
  );
}
