import { codexRateLimitReached, codexRateLimitWindow, type RateLimitState } from '@verity/events';
import type { FetchLike } from './claudeUsage.js';
import { CodexSignInUnusableError } from './codex-sign-in-error.js';

/**
 * Codex subscription quota probe — the Codex counterpart to {@link ./claudeUsage.ts}.
 *
 * Codex reports its quota with every turn, and the session backend records that
 * into `rate_limit` events. That signal alone is EVENT-DRIVEN and SESSION-SCOPED:
 * it only advances when an interactive Verity session finishes a turn, it is not
 * written at all by the `codex exec` runs that also consume the account quota, and
 * the overview only aggregates sessions still in the list. So the meter freezes at
 * whatever the last interactive turn saw and silently drifts — that is the defect
 * this probe fixes. Claude never had it, because `/provider-limits` polls the
 * account-global endpoint independently of any session.
 *
 * The account-global source is `GET https://chatgpt.com/backend-api/wham/usage`,
 * the same undocumented endpoint the Codex CLI reads. It answers the quota in one
 * of TWO spellings the CLI accepts — both are read, see the container/window field
 * tables below — one of which is the `rate_limits` shape the rollouts already
 * carry, so both readers share the mapping helpers in `@verity/events`.
 *
 * Being undocumented is the whole reason {@link CodexUsageHealth} exists: when
 * this endpoint changes or refuses, nothing about the rendered meter says so. It
 * keeps showing the last per-session number, which is a WRONG value rather than a
 * missing one, and it is the number the operator plans their day around.
 *
 * Two properties are deliberate:
 *   - The token comes from the Agent Gateway over the control channel, never from
 *     a second copy of the rotating refresh token. The gateway stays the single
 *     refresh authority (ADR 0010); this poller is just another consumer.
 *   - The request is made by the SERVER, not through the sandbox-facing egress
 *     allowlist. `/wham/usage` is not a route an agent may reach; adding it there
 *     would widen the sandbox's reach for no reason.
 *
 * Caching, backoff and the never-throws contract mirror the Claude probe: one
 * server-side poller serves every overview client, an unavailable probe yields
 * `[]`, and the overview falls back to the per-session event signal.
 */

/** Codex's Bearer token plus the account it is scoped to. */
export interface CodexUsageCredential {
  accessToken: string;
  accountId: string;
}

/** Resolves the gateway-held Codex credential; `undefined` when no login exists. */
export type CodexUsageCredentialProvider = () => Promise<CodexUsageCredential | undefined>;

/**
 * The endpoint moved with the backend deployment and the CLI still carries both
 * paths. Try them in order and pin the first that answers; only a 404 advances to
 * the next candidate, every other failure backs off as usual.
 */
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const LEGACY_USAGE_URL = 'https://chatgpt.com/backend-api/api/codex/usage';
const USAGE_URLS: readonly string[] = [USAGE_URL, LEGACY_USAGE_URL];
/** Success cache TTL — how long a good reading is served before a refetch. */
const DEFAULT_TTL_MS = 5 * 60_000;
/** First backoff step after a failure; doubles up to the cap. */
const DEFAULT_MIN_RETRY_MS = 60_000;
/**
 * Backoff ceiling. Exported only so a test can pin it against
 * `USAGE_PROBE_STALL_MS`: the banner for a stalled probe waits out that window,
 * so a ceiling raised past it would silence the banner with everything still
 * green. Nothing in `attention.ts` imports this — the constraint is one-way and
 * lives in the test.
 */
export const CODEX_USAGE_MAX_BACKOFF_MS = 5 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  // Arrays excluded deliberately: `rate_limits: []` would otherwise pass as a
  // container with no window in it, i.e. as a perfectly idle account.
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asPercent(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, value));
}

function asCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.trunc(value);
}

/**
 * Where the two windows sit, and what each of the three facts is called.
 *
 * The endpoint is undocumented, and the Codex CLI binary carries TWO spellings
 * for the same window: `primary`/`secondary` holding `used_percent`,
 * `window_minutes` and `resets_at` (the shape the rollout stream also uses), and
 * `primary_window`/`secondary_window` holding `used_percent`,
 * `limit_window_seconds` and `reset_after_seconds` — a DURATION, not an instant.
 * Which one a given account gets depends on a backend Verity does not control.
 *
 * So read either rather than betting on one. Every alternative below is a name
 * the CLI itself deserializes, not a guess, and a body carrying neither is
 * reported as {@link CodexUsageHealth} `unreadable`.
 *
 * Both are tried PER WINDOW, and the first that actually yields that window wins
 * rather than the first that merely EXISTS: a backend mid-rollout can send both
 * containers — one an empty husk, or each naming a different window — and either
 * stopping at the husk or taking the first container whole would drop a window
 * Verity was told about.
 */
const CONTAINER_FIELDS = ['rate_limits', 'rate_limit'] as const;
/** The one non-window key a container is known to carry. */
const REACHED_TYPE = 'rate_limit_reached_type';
const WINDOW_FIELDS = {
  primary: ['primary', 'primary_window'],
  secondary: ['secondary', 'secondary_window'],
} as const;

function records(
  source: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown>[] {
  return fields.map((field) => source[field]).filter(isRecord);
}

/** Window length in minutes, whichever unit this body states it in. */
function windowMinutes(limit: Record<string, unknown>): number | undefined {
  // Zero is not a window length, it is a field that was not filled in; keep
  // looking rather than let it beat a stated duration in the other unit.
  const minutes = asCount(limit['window_minutes']);
  if (minutes !== undefined && minutes > 0) return minutes;
  const seconds = asCount(limit['limit_window_seconds']);
  return seconds === undefined || seconds <= 0 ? undefined : Math.round(seconds / 60);
}

/**
 * The window's end as epoch SECONDS. `resets_at` already is one; the duration
 * spellings are relative to when this reading was taken, which is why they are
 * resolved here rather than left for the client to interpret.
 */
function resetsAtSeconds(limit: Record<string, unknown>, observedAt: number): number | undefined {
  const at = asCount(limit['resets_at']);
  if (at !== undefined && at > 0) return at;
  // Zero is not a remaining duration, it is a field that was not filled in — the
  // same reading `window_minutes` gets above. Taking it literally would place the
  // window's end at this instant, which the client hides on sight: a window
  // silently missing from the meter while the probe reports healthy, the one
  // outcome `understood` exists to prevent. Unresolved, it makes the window
  // unreadable instead, which is what it is.
  const after = asCount(limit['reset_after_seconds']);
  return after === undefined || after <= 0 ? undefined : Math.floor(observedAt / 1000) + after;
}

/**
 * Map one reported window onto the canonical {@link RateLimitState}. Returns null
 * when the window is absent or states neither a usage nor a reset, and a window
 * at/over 100% is surfaced as `rejected`.
 */
function toState(
  limit: unknown,
  field: 'primary' | 'secondary',
  fallbackWindow: RateLimitState['window'],
  reachedType: string | undefined,
  observedAt: number,
): RateLimitState | null {
  if (!isRecord(limit)) return null;
  const window = codexRateLimitWindow(windowMinutes(limit) ?? 0, fallbackWindow);
  const usedPercent = asPercent(limit['used_percent']);
  const resetsAt = resetsAtSeconds(limit, observedAt);
  if (usedPercent === undefined || resetsAt === undefined || resetsAt <= 0) return null;
  return {
    status: codexRateLimitReached(reachedType, field, window, usedPercent) ? 'rejected' : 'allowed',
    resetsAt,
    window,
    usedPercent,
    providerLabel: 'Codex',
    observedAt,
  };
}

/** What one usage body yielded, and whether Verity believes that is all of it. */
export interface CodexUsageReading {
  readonly states: RateLimitState[];
  /**
   * Whether every window this body NAMED was actually placed.
   *
   * The states alone cannot say this, and the difference is the whole point of
   * the probe. An empty answer is a normal one — an account with nothing running
   * — so it must never raise a banner. A body that names a window and yields
   * nothing for it is the opposite: the account may well have a live window the
   * meter cannot show, and nothing downstream would ever notice.
   *
   * It is per WINDOW, not per body, so a half-moved shape is caught at full
   * resolution: if only the weekly window's spelling changes, the five-hour one
   * still parses and the reading would otherwise look complete while the meter
   * quietly loses a row.
   */
  readonly understood: boolean;
}

/**
 * Read a Codex usage body into canonical quota states. Pure + defensive: unknown
 * or garbled input yields no states rather than throwing, so a changed response
 * shape degrades to the event-driven signal instead of breaking the overview.
 *
 * Both spellings are searched PER WINDOW rather than per container: a body
 * carrying the old spelling for one window and the new one for the other — what
 * a half-finished rollout looks like — would otherwise lose whichever window the
 * first container did not name, and report the survivor as a complete answer.
 */
export function readCodexUsage(body: unknown, observedAt: number): CodexUsageReading {
  if (!isRecord(body)) return { states: [], understood: false };
  const containers = records(body, CONTAINER_FIELDS);
  // Neither a known container nor a window named at the root: not an idle account,
  // a body from somewhere else. The root clause is what lets a body that carries
  // its windows there and nowhere else still be read.
  if (containers.length === 0 && !namesKnownWindow(body)) return { states: [], understood: false };
  const states: RateLimitState[] = [];
  let understood = true;
  for (const [field, fallbackWindow] of [
    ['primary', 'five_hour'],
    ['secondary', 'weekly'],
  ] as const) {
    const named = namedWindows(containers, body, field);
    const state = named.reduce<RateLimitState | null>(
      (found, { limit, reachedType }) =>
        found ?? toState(limit, field, fallbackWindow, reachedType, observedAt),
      null,
    );
    if (state !== null) states.push(state);
    else if (named.length > 0) understood = false;
  }
  // Both containers AND the root, because both are searched for windows above.
  const sources = [...containers, body];
  return {
    states,
    understood: understood && (sources.some(namesKnownWindow) || sources.every(hidesNoWindow)),
  };
}

/**
 * The keys that make an object a usage window rather than any other object.
 *
 * Every one of them states a WINDOW — when it ends, or how long it runs.
 * `used_percent` is deliberately not among them: plenty of things this endpoint
 * could grow are measured in percent, the credits balance beside the two windows
 * most obviously, and on an idle account there is no parsed window to prove the
 * shape is fine. A window with neither a reset nor a length could not be rendered
 * anyway, so nothing readable is lost by ignoring one.
 */
const WINDOW_MARKERS: readonly string[] = [
  'resets_at',
  'reset_after_seconds',
  'window_minutes',
  'limit_window_seconds',
];

/**
 * Every key a body is expected to carry where a window could hide. The containers
 * are in it because the audit below is asked of the body's ROOT as well, and
 * `rate_limits` is the most expected key there is.
 */
const KNOWN_KEYS: ReadonlySet<string> = new Set<string>([
  ...WINDOW_FIELDS.primary,
  ...WINDOW_FIELDS.secondary,
  ...CONTAINER_FIELDS,
  REACHED_TYPE,
]);

/**
 * Whether a container holds no window under a name Verity does not know.
 *
 * This is what keeps a RENAMED window from reading as an idle account. `named`
 * above can only see windows under a name it already knows, so a container that
 * moved from `primary` to, say, `five_hour` names no window by that test, yields
 * no state, and would otherwise be indistinguishable from `{}` — an account with
 * nothing running. It is the same rename the two spellings above are evidence the
 * backend does, and getting it wrong blanks a live meter and reports healthy.
 *
 * What makes an unknown key suspicious is its VALUE, not its name: an object
 * carrying a percentage or a reset is a window whatever it is called, and no
 * ordinary added field looks like one. Refusing every unknown key instead would
 * mean a permanent banner the first time this undocumented endpoint grows a
 * `plan_tier` — on a meter that is completely right — and a banner that is always
 * on is one nobody reads when it finally means something.
 *
 * Only the container's own values are examined, because that is where a window
 * lives in both spellings; an array is looked into so a `windows: [...]` list
 * cannot hide one.
 *
 * Asked of every place a window is searched for — both containers and the body's
 * own root — and only when NONE of them named a window Verity knows, which is the
 * case this exists for. A body still naming `primary` somewhere is not mid-rename,
 * and its unknown neighbours are far likelier to be another metric this endpoint
 * grew — the account page shows a credits balance beside the windows, and a
 * `credits` object carrying `used_percent` is exactly what that would arrive as.
 * Judging those too would put a permanent, unfalsifiable "may be missing a window"
 * line over a meter that is completely right. A husk — `primary: {}` — is caught
 * by the named-but-unreadable rule above instead, not here.
 *
 * Two holes are left, both deliberate: a window whose NAME and FIELD names all
 * change in one release leaves nothing to recognise it by, and a rename of ONE
 * window while another window keeps its name reads as the single-window plan that
 * a weekly-only account genuinely is. Both are pinned by tests, so they are
 * decisions rather than surprises. Closing either means guessing that any object
 * at all is a window, which makes `credits` one.
 */
function hidesNoWindow(container: Record<string, unknown>): boolean {
  return Object.entries(container).every(
    ([key, value]) => KNOWN_KEYS.has(key) || !looksLikeWindow(value),
  );
}

/**
 * The key names by which a body Verity could not read is described, for the log
 * and for `health()`.
 *
 * Top-level keys alone would report `rate_limits` for the dominant drift case — a
 * window renamed INSIDE the container — naming the one key that did not move.
 * Known containers are therefore unfolded one level, as `rate_limits.five_hour`.
 * Names only, never values: a quota body is not secret, but nothing here is worth
 * the habit of logging payload contents.
 *
 * Capped, because this goes into a log line and into a retained signature: the
 * answer that lands here is by definition not the one this file expects, and
 * "some error envelope with a hundred keys" is a perfectly ordinary way for that
 * to be true. The overflow is counted rather than dropped silently.
 */
const MAX_SHAPE_FIELDS = 24;

function shapeFields(body: unknown): string[] {
  if (!isRecord(body)) return [];
  const fields = Object.keys(body);
  for (const field of CONTAINER_FIELDS) {
    const container = body[field];
    if (isRecord(container)) fields.push(...Object.keys(container).map((key) => `${field}.${key}`));
  }
  fields.sort();
  if (fields.length <= MAX_SHAPE_FIELDS) return fields;
  return [...fields.slice(0, MAX_SHAPE_FIELDS), `+${fields.length - MAX_SHAPE_FIELDS} more`];
}

/** Whether a container names at least one window under a name Verity knows. */
function namesKnownWindow(container: Record<string, unknown>): boolean {
  return [...WINDOW_FIELDS.primary, ...WINDOW_FIELDS.secondary].some((field) =>
    isRecord(container[field]),
  );
}

function looksLikeWindow(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(looksLikeWindow);
  if (!isRecord(value)) return false;
  return WINDOW_MARKERS.some((marker) => marker in value);
}

/**
 * Every object named as this window, across both containers and both spellings.
 *
 * The body's own root is searched last, as a container in its own right. A window
 * promoted out of `rate_limits` — `{ rate_limits: {}, primary_window: {…} }` — is
 * the other way this endpoint could move a window, and it is worth reading rather
 * than merely detecting: the container is still there and still parses, so
 * nothing downstream would call the resulting empty answer anything but an idle
 * account. Searched last so a container's window wins if a body carries both.
 */
function namedWindows(
  containers: readonly Record<string, unknown>[],
  body: Record<string, unknown>,
  field: 'primary' | 'secondary',
): { limit: Record<string, unknown>; reachedType: string | undefined }[] {
  // Named on the container by the snapshot shape and at the root by the payload
  // shape; a window is `rejected` on its own once it reads 100%, so a missing
  // value here only costs the sub-100% "this is the blocked one" hint. Resolved
  // per source rather than by `||`, so a container carrying a non-string under
  // that key cannot shadow a root value that does name a window.
  const rootReachedType = reachedTypeOf(body);
  return [...containers, body].flatMap((container) => {
    const reachedType = reachedTypeOf(container) ?? rootReachedType;
    return records(container, WINDOW_FIELDS[field]).map((limit) => ({ limit, reachedType }));
  });
}

function reachedTypeOf(source: Record<string, unknown>): string | undefined {
  const raw = source[REACHED_TYPE];
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

/** The states of {@link readCodexUsage}, for callers that only map. */
export function parseCodexUsage(body: unknown, observedAt: number): RateLimitState[] {
  return readCodexUsage(body, observedAt).states;
}

/**
 * What the last refresh attempt learned. Exists because every failure below is
 * SILENT by design: the probe never throws, so a meter that is quietly serving
 * the frozen per-session value looks exactly like a meter that is right. The
 * overview's attention banner reads this so it cannot look fine while lying.
 *
 * `idle` and `unreadable` split what an empty answer can mean, because the empty
 * result alone cannot: an account with no window running is FINE and must never
 * be banner-worthy, a body we could not read is the defect. `unreadable` carries
 * the body's top-level field names — names only, never values — so the shape it
 * moved to is legible without a debugger.
 *
 * `no-credential` carries `everWorked`, which is the same distinction again: a
 * Server that never had a Codex login is unconfigured, one whose login stopped
 * resolving has silently stopped updating a meter that is still on screen.
 *
 * `sign-in-rejected` splits the case that USED to land in `failed` and be
 * described as unreachable: the gateway answered, and the login it holds cannot be
 * used without a new one. It is the only failure here that names its own remedy,
 * and the only one that also stops Codex sessions dead rather than merely freezing
 * a number. It needs no `everWorked` of its own — a refusal presupposes a login to
 * refuse, so the unconfigured case it would guard against cannot reach it.
 *
 * Every unhealthy variant carries `since`, the start of the CURRENT unbroken run
 * of failure, so a caller can require that a failure has lasted before it says
 * anything. One 429 during a backoff step is not worth a banner; the same 429
 * still failing an hour later is the whole point.
 */
export type CodexUsageHealth =
  | { readonly state: 'unconfigured' }
  | { readonly state: 'pending' }
  | { readonly state: 'ok'; readonly windows: number; readonly at: number }
  | { readonly state: 'idle'; readonly at: number }
  | {
      readonly state: 'no-credential';
      readonly everWorked: boolean;
      readonly at: number;
      readonly since: number;
    }
  | {
      readonly state: 'sign-in-rejected';
      readonly at: number;
      readonly since: number;
    }
  | {
      readonly state: 'http-error';
      readonly status: number | undefined;
      readonly at: number;
      readonly since: number;
    }
  | {
      readonly state: 'unreadable';
      readonly fields: readonly string[];
      /**
       * How many windows that same answer DID place. Not a detail: at zero the
       * meter is serving the frozen per-session value, above zero it is serving a
       * fresh account-global one that may be missing a row. Those are different
       * things to tell someone, and only this number tells them apart.
       */
      readonly windows: number;
      readonly at: number;
      readonly since: number;
    }
  | { readonly state: 'failed'; readonly at: number; readonly since: number };

/** Structured logger for the probe's failure branches (Fastify's pino fits as-is). */
export interface CodexUsageLogger {
  debug(data: Record<string, unknown>, msg: string): void;
  warn(data: Record<string, unknown>, msg: string): void;
}

const NOOP_LOGGER: CodexUsageLogger = {
  debug: () => {},
  warn: () => {},
};

export interface CodexUsageOptions {
  /** Diagnostic logger. Each failure branch (no credential, non-2xx, 2xx-but-empty
   *  parse, exception) logs a reason so an empty Codex meter can be traced. Never
   *  logs the token itself. Defaults to a no-op. */
  log?: CodexUsageLogger;
  /** Gateway-held Codex credential. Absent → the probe is inert and yields `[]`. */
  credentialProvider?: CodexUsageCredentialProvider | undefined;
  /** HTTP client. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Clock, injectable for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Success cache TTL (ms). Deliberately NOT clamped, unlike
   *  {@link CodexUsageOptions.maxBackoffMs}: raising it past
   *  `USAGE_PROBE_STALL_MS` delays the attention banner, and that trade belongs to
   *  whoever is deciding how often to poll somebody else's endpoint. */
  ttlMs?: number;
  /** First backoff step (ms). */
  minRetryMs?: number;
  /**
   * Backoff ceiling (ms), clamped to {@link CODEX_USAGE_MAX_BACKOFF_MS}. The
   * clamp is the point: a ceiling past the attention banner's stall window would
   * leave `health().at` too old to be trusted and silence the banner entirely,
   * with every test still green.
   */
  maxBackoffMs?: number;
}

export interface CodexUsageService {
  /** Latest Codex account quota windows, cached + backed off. Never throws; `[]`
   *  when the probe is unconfigured or has no good reading yet. */
  getLimits(): Promise<RateLimitState[]>;
  /** What the last attempt learned. Read synchronously — it never probes, so the
   *  attention path cannot add latency or a failure mode to `/sessions`. */
  health(): CodexUsageHealth;
}

/**
 * Build the singleton Codex usage probe. Safe to call `getLimits()` on every
 * overview request — it only reaches the ChatGPT backend when the cache is stale
 * and no backoff is pending, dedupes concurrent refreshes, and otherwise returns
 * the last-good value.
 */
export function createCodexUsageService(opts: CodexUsageOptions = {}): CodexUsageService {
  const credentialProvider = opts.credentialProvider;
  const log = opts.log ?? NOOP_LOGGER;
  const doFetch =
    opts.fetch ??
    (typeof globalThis.fetch === 'function'
      ? (url, init) => globalThis.fetch(url, init)
      : undefined);
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const minRetryMs = opts.minRetryMs ?? DEFAULT_MIN_RETRY_MS;
  // The FAILURE cadence is clamped; the success TTL deliberately is not. Both feed
  // how old `health().at` gets, and the banner will not speak for a verdict older
  // than USAGE_PROBE_STALL_MS — but the two overrides mean opposite things. A
  // ceiling raised past that window is not politeness, it is switching the banner
  // off with every test still green, and it applies while the endpoint is already
  // failing. A longer TTL is politeness toward a third-party endpoint that has
  // every right to be polled less; clamping it would mean this file quietly
  // deciding to send MORE requests than it was asked to, and provoking the 429s
  // the banner then reports. So a TTL past the stall window delays the banner, and
  // that is the caller's call to make.
  const requestedMaxBackoffMs = opts.maxBackoffMs ?? CODEX_USAGE_MAX_BACKOFF_MS;
  const maxBackoffMs = Math.min(requestedMaxBackoffMs, CODEX_USAGE_MAX_BACKOFF_MS);
  if (requestedMaxBackoffMs > maxBackoffMs)
    // Said rather than swallowed: a deployment that asked to back off harder gets
    // the ceiling instead, and the reason is not guessable from the outside.
    log.debug(
      { reason: 'backoff-clamped', requestedMaxBackoffMs, maxBackoffMs },
      'verity: codex usage backoff ceiling clamped to keep the usage banner able to fire',
    );

  // Last successful reading and when it was taken; the backoff deadline + step; the
  // in-flight refresh (so concurrent callers share one request); and the endpoint
  // candidate that last answered.
  let cached: RateLimitState[] = [];
  let fetchedAt = 0;
  let hasReading = false;
  let nextAttemptAt = 0;
  let backoffMs = minRetryMs;
  let inflight: Promise<void> | null = null;
  let pinnedUrl: string = USAGE_URL;
  // The last unreadable shape complained about, so the same one is not warned
  // about on every poll. Cleared by a clean read or by any other kind of failure,
  // which makes it once per episode rather than once per process.
  let lastUnreadable: string | null = null;
  // Whether the previous reading was empty, so a meter is only blanked by two of
  // them in a row rather than by one shape Verity happened not to recognise.
  let sawEmpty = false;
  let health: CodexUsageHealth =
    credentialProvider === undefined || !doFetch ? { state: 'unconfigured' } : { state: 'pending' };
  if (health.state === 'unconfigured')
    // Said once, at construction, rather than on every polled `getLimits()`: this
    // probe is inert for the process's whole life (no credential provider wired —
    // a Claude-only deployment, or a gateway control socket the Server never got),
    // and the Codex meter will show whatever a session last reported, forever.
    log.debug(
      {
        reason: 'unconfigured',
        // Both halves, because either one alone makes the probe inert and the two
        // are wired in different places.
        hasCredentialProvider: credentialProvider !== undefined,
        hasFetch: Boolean(doFetch),
      },
      'verity: codex usage probe is not configured; meter serves session events only',
    );

  /** Start of the current unbroken failure run: carried across from an already
   *  failing probe, so failing in a NEW way is still one continuous outage. */
  /**
   * Start of the CURRENT unbroken run of failure.
   *
   * A run may only be inherited across states that are fused the same way. A
   * refusal is the one that is not — it banners after a far shorter wait — so a
   * network outage that happened to precede it must not have its age spent on the
   * refusal's fuse, and a refusal that gives way to an outage must not lend its own.
   */
  function failingSince(at: number, state: CodexUsageHealth['state']): number {
    if (!('since' in health)) return at;
    const sameFuse = (health.state === 'sign-in-rejected') === (state === 'sign-in-rejected');
    return sameFuse ? health.since : at;
  }

  function backOff(): void {
    backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    nextAttemptAt = now() + backoffMs;
    // A failure ends the run of empty readings too. Otherwise a held-back empty
    // followed by an outage would let the FIRST empty answer after recovery blank
    // the meter — the two-empties rule dropped exactly where a shape change is
    // most likely to have happened.
    sawEmpty = false;
  }

  async function refresh(): Promise<void> {
    if (!doFetch || credentialProvider === undefined) return;
    try {
      // A rejected SIGN-IN gets its own state; anything else the provider throws
      // (control socket down, network) falls through to the catch-all, which is
      // still the honest answer for it.
      let credential: CodexUsageCredential | undefined;
      try {
        credential = await credentialProvider();
      } catch (error) {
        if (!(error instanceof CodexSignInUnusableError)) throw error;
        log.warn(
          { reason: 'sign-in-rejected', err: error },
          'verity: gateway refused the codex sign-in; meter stays on its last reading',
        );
        const at = now();
        // Carries no `everWorked`, unlike `no-credential`: a refusal is only
        // reported for a login that EXISTS and cannot be used, so the state itself
        // already rules out the unconfigured case that flag guards against. It is
        // also therefore true across a restart, which is when this is most likely
        // to be read.
        health = { state: 'sign-in-rejected', at, since: failingSince(at, 'sign-in-rejected') };
        lastUnreadable = null;
        backOff();
        return;
      }
      if (credential === undefined) {
        // No Codex login reachable: sealed settings store, unconfigured account, or
        // a gateway that has not been configured yet. Claude is unaffected (it uses
        // its own credential), so this is the usual "Codex meter empty".
        log.warn(
          { reason: 'no-credential' },
          'verity: codex usage probe has no gateway credential; meter stays empty',
        );
        const at = now();
        // Windows, not merely a 2xx: the banner this flag arms says the meter is
        // showing an older number, and an account that was idle when its login
        // stopped resolving has no number on screen to be older. Same reason it is
        // `cached` rather than the last reading — that is what `/provider-limits`
        // is actually still serving.
        //
        // Process-local, so a Server restarted while the Codex login is already
        // broken reports `everWorked: false` and stays silent. Accepted: that state
        // is indistinguishable from a Server that never had a login, and guessing
        // wrong the other way banners every Codex-less deployment forever.
        health = {
          state: 'no-credential',
          everWorked: hasReading && cached.length > 0,
          at,
          since: failingSince(at, 'no-credential'),
        };
        // As in the other failure branches: a different fault ends the unreadable
        // episode, so the same moved shape returning later is warned about again.
        lastUnreadable = null;
        backOff();
        return;
      }
      // A 404 means this deployment serves the other path; try each candidate once
      // per refresh and remember the one that answered.
      let res: Awaited<ReturnType<FetchLike>> | undefined;
      for (const url of [pinnedUrl, ...USAGE_URLS.filter((candidate) => candidate !== pinnedUrl)]) {
        res = await doFetch(url, {
          headers: {
            authorization: `Bearer ${credential.accessToken}`,
            'chatgpt-account-id': credential.accountId,
            accept: 'application/json',
          },
        });
        if (res.ok) {
          pinnedUrl = url;
          break;
        }
        if (res.status !== 404) break;
      }
      if (res === undefined || !res.ok) {
        // 401/403 (token rejected), 429 (rate-limited), 404 on every candidate, or
        // any other non-2xx: back off, keep last-good. The status distinguishes a
        // transient limit from a bad credential or a moved endpoint.
        log.warn(
          { reason: 'non-2xx', status: res?.status },
          'verity: codex usage probe returned non-2xx; backing off',
        );
        const at = now();
        // Bannered whether or not this Server ever had a good reading, unlike the
        // no-credential case above. The difference is that a refusal means a Codex
        // login EXISTS and the endpoint will not serve it: somebody signed in, and
        // the meter they are looking at is not their account's. "No login at all"
        // is a setup state; "a login that is refused" is a fault either way.
        health = {
          state: 'http-error',
          status: res?.status,
          at,
          since: failingSince(at, 'http-error'),
        };
        // A different failure ends the unreadable episode, so the same moved shape
        // returning later is worth saying out loud again.
        lastUnreadable = null;
        backOff();
        return;
      }
      const observedAt = now();
      // An endpoint that answered 2xx with something that isn't JSON has NOT
      // become unreachable, and saying so would point at the network instead of
      // at the shape. Parse failures join the unreadable branch below.
      let body: unknown;
      let parsed = true;
      try {
        body = await res.json();
      } catch {
        body = undefined;
        parsed = false;
      }
      const { states, understood } = readCodexUsage(body, observedAt);
      // Anything we can serve replaces the cache and resumes the normal cadence:
      // every window that WAS placed, and a genuine "nothing is running". A fresh
      // half-answer still beats a stale whole one, and the endpoint plainly answers.
      //
      // Nothing expires the cache when reads stop succeeding, and that is on
      // purpose. Each state carries the reset instant it was read with, and the
      // overview hides any row whose instant has passed (`isLimitVisible` in
      // `mobile/src/models/sessionList.ts`), so last-good ages out of the meter by
      // itself within one window — while a `getLimits()` that started returning
      // nothing would blank a meter that was right minutes ago, with no reason
      // given. The banner is what covers the interval in between.
      if (states.length > 0 || understood) {
        // ...with one reservation, for the one shape Verity cannot recognise at
        // all: a window renamed together with its fields reads as "no window is
        // running", which is indistinguishable from an account that genuinely went
        // quiet, and acting on it blanks a live meter with nothing said. So an
        // empty reading has to arrive twice before it replaces a meter that had
        // something in it. An account that really is idle shows it one refresh
        // later; a shape that moved gets a second chance to say something else.
        const blanking = states.length === 0 && cached.length > 0;
        if (!blanking || sawEmpty) cached = states;
        sawEmpty = states.length === 0;
        fetchedAt = observedAt;
        hasReading = true;
        backoffMs = minRetryMs;
        nextAttemptAt = 0;
      }
      if (!understood) {
        // 2xx naming a window we could not place: the undocumented shape has moved,
        // wholly or in part. NOT a reading — the health stays `unreadable` so the
        // overview can say the meter is incomplete, and with nothing usable in hand
        // the last good percentage is kept (still the freshest account-global number
        // anyone has) rather than blanking the meter and re-polling a moved endpoint
        // at full rate. The field NAMES go to the log (never values) so the new shape
        // is legible without a debugger. A body that was not even JSON gets its own
        // reason: "the endpoint moved" and "the endpoint returned garbage" call for
        // different people, and both arrive here with nothing to read.
        const fields = shapeFields(body);
        const reason = parsed ? 'empty-parse' : 'unparsable-body';
        // A half-read answer keeps the normal cadence rather than backing off, so
        // the same complaint would otherwise land every TTL for as long as the
        // shape stays moved. Warn on each NEW shape, then drop to debug: the state
        // is on the overview and in `health()`, and a log line repeating every few
        // minutes forever is how the next real warning gets missed.
        const signature = `${reason}:${states.length}:${fields.join(',')}`;
        const message = parsed
          ? 'verity: codex usage probe returned 2xx in an unrecognized shape'
          : 'verity: codex usage probe returned 2xx that is not JSON';
        const data = { reason, windows: states.length, fields };
        if (signature === lastUnreadable) log.debug(data, message);
        else log.warn(data, message);
        lastUnreadable = signature;
        health = {
          state: 'unreadable',
          fields,
          windows: states.length,
          at: observedAt,
          since: failingSince(observedAt, 'unreadable'),
        };
        if (states.length === 0) backOff();
        return;
      }
      lastUnreadable = null;
      if (states.length === 0) {
        // A shape we read, reporting no window running. Normal for an account that
        // has not spent anything this period — not a defect, and deliberately not
        // worth telling anyone about. It IS a reading, so it replaces the cache:
        // "nothing is running" is the current truth, not a gap in our knowledge.
        log.debug({ reason: 'no-windows' }, 'verity: codex usage probe reports no active window');
        // ...unless the rule above is still holding the previous windows back for
        // one refresh, in which case `idle` would describe a meter nobody is
        // looking at. Health reports what is being SERVED, so that the one place
        // reading it cannot conclude anything the screen contradicts.
        health =
          cached.length > 0
            ? { state: 'ok', windows: cached.length, at: observedAt }
            : { state: 'idle', at: observedAt };
      } else {
        log.debug({ windows: states.length }, 'verity: codex usage probe refreshed');
        health = { state: 'ok', windows: states.length, at: observedAt };
      }
    } catch (error) {
      // Network/parse/control-channel failure: identical backoff, serve last-good.
      log.warn({ reason: 'exception', err: error }, 'verity: codex usage probe threw; backing off');
      const at = now();
      health = { state: 'failed', at, since: failingSince(at, 'failed') };
      lastUnreadable = null;
      backOff();
    }
  }

  return {
    health(): CodexUsageHealth {
      return health;
    },
    async getLimits(): Promise<RateLimitState[]> {
      if (credentialProvider === undefined || !doFetch) return [];
      const t = now();
      const fresh = hasReading && t - fetchedAt < ttlMs;
      const backingOff = t < nextAttemptAt;
      if (!fresh && !backingOff) {
        // Refresh once for concurrent callers; failures never propagate.
        inflight ??= refresh().finally(() => {
          inflight = null;
        });
        await inflight;
      }
      return cached;
    },
  };
}
