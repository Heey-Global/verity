import type { HttpFetch } from './github.js';

/** Result of a live Doppler Service Account token validation (`POST /doppler/validate`,
 *  #320). On success it MAY carry a SAFE, non-secret confirmation (the number of
 *  projects the token can list) so the UI can echo "connected (N projects)". It
 *  NEVER carries the token or any Doppler response body — the failure `error` is a
 *  fixed, redacted message, never a raw Doppler body (those can echo request
 *  context). */
export interface DopplerValidateResult {
  ok: boolean;
  /** SAFE confirmation on success: how many projects the token can list. Absent
   *  when Doppler omits a countable list. Never the token. */
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
 * A `200` proves the token is valid and account-scoped; the response's project
 * list length is lifted out as a SAFE confirmation count.
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

  let res;
  try {
    res = await doFetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'verity',
      },
      signal: AbortSignal.timeout(timeoutMs),
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

/**
 * List the account's Doppler projects for the binding picker (#320): `GET
 * /v3/projects` with the account token as a Bearer credential. Returns only the
 * NON-secret `{ slug, name }` summaries.
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
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const apiBaseUrl = opts.apiBaseUrl ?? 'https://api.doppler.com';
  const url = `${apiBaseUrl.replace(/\/+$/, '')}/v3/projects`;

  let res;
  try {
    res = await doFetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'verity',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Network / timeout / abort — never includes the token.
    throw new Error('could not reach Doppler');
  }

  if (!res.ok) throwRedactedDopplerError(res.status);

  const body = (await res.json()) as DopplerProjectsResponse;
  return mapDopplerProjects(body);
}

/**
 * List a Doppler project's configs for the binding picker (#320): `GET
 * /v3/configs?project=<project>` with the account token as a Bearer credential.
 * Returns only the NON-secret `{ name, environment?, root? }` summaries.
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
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const apiBaseUrl = opts.apiBaseUrl ?? 'https://api.doppler.com';
  const url = `${apiBaseUrl.replace(/\/+$/, '')}/v3/configs?project=${encodeURIComponent(project)}`;

  let res;
  try {
    res = await doFetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'verity',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error('could not reach Doppler');
  }

  if (!res.ok) throwRedactedDopplerError(res.status);

  const body = (await res.json()) as DopplerConfigsResponse;
  return mapDopplerConfigs(body);
}
