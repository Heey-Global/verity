import { describe, expect, it } from 'vitest';
import { USAGE_PROBE_STALL_MS } from './attention.js';
import type { FetchLike } from './claudeUsage.js';
import {
  createCodexUsageService,
  parseCodexUsage,
  readCodexUsage,
  CODEX_USAGE_MAX_BACKOFF_MS,
  type CodexUsageCredential,
  type CodexUsageLogger,
} from './codexUsage.js';
import { CodexSignInUnusableError } from './codex-sign-in-error.js';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const LEGACY_USAGE_URL = 'https://chatgpt.com/backend-api/api/codex/usage';
const CREDENTIAL: CodexUsageCredential = { accessToken: 'codex-token', accountId: 'acct-1' };
const OBSERVED_AT = 1_781_000_000_000;

/** The `/wham/usage` body: the same `rate_limits` shape the rollouts carry. */
const USAGE_BODY = {
  rate_limits: {
    primary: { used_percent: 95.4, window_minutes: 10080, resets_at: 1_781_083_600 },
    secondary: { used_percent: 12, window_minutes: 300, resets_at: 1_781_002_000 },
  },
  credits: { has_credits: false, unlimited: false, balance: 0 },
  plan_type: 'plus',
};

function recordingFetch(
  respond: (url: string) => { ok: boolean; status: number; body?: unknown },
): { fetch: FetchLike; urls: string[]; inits: Array<Parameters<FetchLike>[1]> } {
  const urls: string[] = [];
  const inits: Array<Parameters<FetchLike>[1]> = [];
  const fetch: FetchLike = (url, init) => {
    urls.push(url);
    inits.push(init);
    const { ok, status, body } = respond(url);
    return Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
  };
  return { fetch, urls, inits };
}

function collectingLogger(): { log: CodexUsageLogger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    log: {
      debug: () => {},
      warn: (data) => {
        warnings.push(String(data['reason']));
      },
    },
  };
}

describe('parseCodexUsage', () => {
  it('maps each window by its length, not by its position', () => {
    // A weekly-only plan reports the weekly cap as `primary`; the fallback that
    // position implies must lose against the reported `window_minutes`.
    expect(parseCodexUsage(USAGE_BODY, OBSERVED_AT)).toEqual([
      {
        status: 'allowed',
        resetsAt: 1_781_083_600,
        window: 'weekly',
        usedPercent: 95.4,
        providerLabel: 'Codex',
        observedAt: OBSERVED_AT,
      },
      {
        status: 'allowed',
        resetsAt: 1_781_002_000,
        window: 'five_hour',
        usedPercent: 12,
        providerLabel: 'Codex',
        observedAt: OBSERVED_AT,
      },
    ]);
  });

  it('falls back to the positional window when the length is unknown', () => {
    expect(
      parseCodexUsage(
        { rate_limits: { primary: { used_percent: 1, resets_at: 10 } } },
        OBSERVED_AT,
      ),
    ).toEqual([
      {
        status: 'allowed',
        resetsAt: 10,
        window: 'five_hour',
        usedPercent: 1,
        providerLabel: 'Codex',
        observedAt: OBSERVED_AT,
      },
    ]);
  });

  it('reports an exhausted window as rejected, by percent or by reached type', () => {
    const full = parseCodexUsage(
      { rate_limits: { primary: { used_percent: 100, window_minutes: 10080, resets_at: 10 } } },
      OBSERVED_AT,
    );
    expect(full[0]?.status).toBe('rejected');
    const flagged = parseCodexUsage(
      {
        rate_limits: {
          rate_limit_reached_type: 'primary',
          primary: { used_percent: 80, window_minutes: 10080, resets_at: 10 },
        },
      },
      OBSERVED_AT,
    );
    expect(flagged[0]?.status).toBe('rejected');
  });

  it('reads the account-payload spelling, resolving its reset DURATION to an instant', () => {
    // The other vocabulary the Codex CLI deserializes for the very same fact:
    // `rate_limit` rather than `rate_limits`, `*_window` rather than the bare
    // name, seconds rather than minutes, and a countdown rather than an instant.
    // Reading only the first spelling is what leaves the meter on a stale value.
    expect(
      parseCodexUsage(
        {
          rate_limit: {
            rate_limit_reached_type: 'secondary',
            primary_window: {
              used_percent: 4,
              limit_window_seconds: 18_000,
              reset_after_seconds: 600,
            },
            secondary_window: {
              used_percent: 95,
              limit_window_seconds: 604_800,
              reset_after_seconds: 36_000,
            },
          },
          plan_type: 'plus',
        },
        OBSERVED_AT,
      ),
    ).toEqual([
      {
        status: 'allowed',
        resetsAt: Math.floor(OBSERVED_AT / 1000) + 600,
        window: 'five_hour',
        usedPercent: 4,
        providerLabel: 'Codex',
        observedAt: OBSERVED_AT,
      },
      {
        status: 'rejected',
        resetsAt: Math.floor(OBSERVED_AT / 1000) + 36_000,
        window: 'weekly',
        usedPercent: 95,
        providerLabel: 'Codex',
        observedAt: OBSERVED_AT,
      },
    ]);
  });

  it('keeps looking past an empty container of the other spelling', () => {
    // A backend mid-rollout can send both names, one an empty husk. Stopping at
    // the husk would report a perfectly working endpoint as unreadable.
    const states = parseCodexUsage(
      {
        rate_limits: {},
        rate_limit: {
          primary_window: {
            used_percent: 7,
            limit_window_seconds: 18_000,
            reset_after_seconds: 60,
          },
        },
      },
      OBSERVED_AT,
    );
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ usedPercent: 7, window: 'five_hour' });
  });

  it('merges the two spellings per window, not per container', () => {
    // The other half of a mid-rollout body: each container names one window. Taking
    // the first container that yields anything would silently drop the weekly one.
    const states = parseCodexUsage(
      {
        rate_limits: {
          primary: { used_percent: 7, window_minutes: 300, resets_at: 1_781_000_000 },
        },
        rate_limit: {
          secondary_window: {
            used_percent: 95,
            limit_window_seconds: 604_800,
            reset_after_seconds: 600,
          },
        },
      },
      OBSERVED_AT,
    );
    expect(states.map((state) => [state.window, state.usedPercent])).toEqual([
      ['five_hour', 7],
      ['weekly', 95],
    ]);
  });

  it('takes the reached type from the body root as well as the container', () => {
    const states = parseCodexUsage(
      {
        rate_limit_reached_type: 'primary',
        rate_limits: { primary: { used_percent: 80, window_minutes: 10080, resets_at: 10 } },
      },
      OBSERVED_AT,
    );
    expect(states[0]?.status).toBe('rejected');
  });

  it('skips absent or malformed windows and non-object bodies', () => {
    expect(parseCodexUsage({ rate_limits: { primary: null } }, OBSERVED_AT)).toEqual([]);
    expect(parseCodexUsage({ rate_limits: { primary: { used_percent: 5 } } }, OBSERVED_AT)).toEqual(
      [],
    );
    expect(parseCodexUsage({ rate_limits: {} }, OBSERVED_AT)).toEqual([]);
    expect(parseCodexUsage({}, OBSERVED_AT)).toEqual([]);
    expect(parseCodexUsage(null, OBSERVED_AT)).toEqual([]);
    expect(parseCodexUsage('nope', OBSERVED_AT)).toEqual([]);
  });
});

// `understood` is the sole gate between "say nothing" and "put a banner over the
// session list", so it is tested directly rather than only through the service.
describe('readCodexUsage', () => {
  const understood = (body: unknown): boolean => readCodexUsage(body, OBSERVED_AT).understood;

  it('calls a known container with nothing running a body it understood', () => {
    expect(understood({ rate_limits: {}, plan_type: 'plus' })).toBe(true);
    expect(understood({ rate_limit: {} })).toBe(true);
    expect(understood(USAGE_BODY)).toBe(true);
  });

  it('refuses a body whose windows or container it does not recognize', () => {
    expect(understood({ usage: { weekly: { pct: 95 } } })).toBe(false);
    expect(understood({ rate_limits: { primary: { pct: 95 } } })).toBe(false);
    // Named a window and yielded none: whatever it is, it is not an account with
    // nothing running, and treating it as one would blank a live meter.
    expect(understood({ rate_limits: { primary: { used_percent: 0 } } })).toBe(false);
    // The husk case: one spelling empty, the other unrecognizable. The half that
    // is evidence of a shape change has to win over the half that looks idle.
    expect(understood({ rate_limits: {}, rate_limit: { primary_window: { pct: 95 } } })).toBe(
      false,
    );
    expect(understood(null)).toBe(false);
    expect(understood('nope')).toBe(false);
  });

  it('refuses a body it read only HALF of', () => {
    // The failure the states alone cannot show: one window still parses, so the
    // reading looks complete while the weekly meter quietly disappears. Judging
    // completeness per window is what catches it.
    const reading = readCodexUsage(
      {
        rate_limits: {
          primary: { used_percent: 7, window_minutes: 300, resets_at: 1_781_000_000 },
          secondary: { pct: 95, ends: 'thursday' },
        },
      },
      OBSERVED_AT,
    );
    expect(reading.states).toHaveLength(1);
    expect(reading.understood).toBe(false);
  });

  it('refuses a container whose WINDOW was renamed, which looks idle by nothing', () => {
    // The rename one level up. There is no window under a name we know, so the
    // states are empty exactly as for `{ rate_limits: {} }` — and calling that an
    // idle account blanks a live meter and reports the probe healthy. An unknown
    // key in the container is the only thing that tells the two apart.
    expect(
      understood({
        rate_limits: {
          five_hour: { used_percent: 7, resets_at: 1_781_000_000 },
          weekly: { used_percent: 95, resets_at: 1_781_083_600 },
        },
      }),
    ).toBe(false);
    // A window hidden in a list under a name we do not know is still a window —
    // recognised by the reset it states, which is what makes it one.
    expect(
      understood({ rate_limit: { windows: [{ used_percent: 95, resets_at: 1_781_083_600 }] } }),
    ).toBe(false);
    // An array is not an empty container either.
    expect(understood({ rate_limits: [] })).toBe(false);
    // ...while the keys a container is known to carry keep it idle.
    expect(understood({ rate_limits: { rate_limit_reached_type: 'primary' } })).toBe(true);
    // A known window key holding an explicit null is the backend saying nothing
    // runs in that window — a name we understand, answering "none". Only an
    // unknown name is evidence something moved.
    expect(understood({ rate_limits: { primary: null } })).toBe(true);
  });

  it('lets the backend add a field that is plainly not a window', () => {
    // What an undocumented endpoint does most often is grow a key. Refusing every
    // unknown one would put a permanent banner on a meter that is completely
    // right, so what decides is whether the VALUE looks like a window.
    const reading = readCodexUsage(
      { rate_limits: { ...USAGE_BODY.rate_limits, plan_tier: 'pro', credits: { balance: 0 } } },
      OBSERVED_AT,
    );
    expect(reading.states).toHaveLength(2);
    expect(reading.understood).toBe(true);

    // The case the value test exists for, and the one a count test gets wrong: an
    // account on a weekly-only plan, where ONE window is the whole truth, plus the
    // same added key. "Fewer windows than expected" would read that as a possible
    // rename and banner forever.
    const weeklyOnly = readCodexUsage(
      {
        rate_limits: {
          secondary: { used_percent: 95, window_minutes: 10080, resets_at: 1_781_083_600 },
          plan_tier: 'pro',
        },
      },
      OBSERVED_AT,
    );
    expect(weeklyOnly.states.map((state) => state.window)).toEqual(['weekly']);
    expect(weeklyOnly.understood).toBe(true);

    // And the harder version: an added metric that DOES look like a window. The
    // account page shows a credits balance beside the two windows, so this is the
    // realistic growth, not a hypothetical. Both windows still parse, so nothing
    // is missing — judging the neighbour would mean an unfalsifiable banner over a
    // meter that is right, forever, with no way to say "yes, that key is fine".
    expect(
      understood({ rate_limits: { ...USAGE_BODY.rate_limits, credits: { used_percent: 40 } } }),
    ).toBe(true);

    // ...and the same key on an IDLE account, where no parsed window is there to
    // vouch for the shape. This is the combination that misfires if a percentage
    // is taken as evidence of a window: a Server whose Codex account happens to be
    // quiet would carry the banner permanently. What marks a window is that it
    // states a window — a reset or a length — not that it states a percentage.
    expect(understood({ rate_limits: {}, credits: { used_percent: 40 } })).toBe(true);
    expect(understood({ rate_limits: { credits: { used_percent: 40 } } })).toBe(true);

    // The line has to fall somewhere, and it falls here: an unknown key that
    // states a RESET, on an account with no window to vouch for the shape, is
    // treated as a window Verity cannot place. Credits that expire would land
    // here wrongly and cost a soft "may be missing a window" line on an idle
    // account — chosen over the alternative, which is a renamed window reading as
    // idle and blanking a live meter while the probe reports healthy. Deciding it
    // in a test, so the next person changes it on purpose.
    expect(understood({ rate_limits: {}, credits: { resets_at: 1_781_083_600 } })).toBe(false);
  });

  it('reads a window the backend promoted out of its container', () => {
    // The other direction a shape can move: the container survives and parses,
    // so an empty one beside a root-level window would read as an idle account
    // and blank a live meter with a healthy verdict. Read it instead of merely
    // refusing the body — the number is right there.
    const reading = readCodexUsage(
      {
        rate_limits: {},
        primary_window: { used_percent: 7, limit_window_seconds: 18_000, reset_after_seconds: 600 },
        rate_limit_reached_type: 'primary',
      },
      OBSERVED_AT,
    );
    expect(reading.states).toEqual([
      {
        status: 'rejected',
        resetsAt: Math.floor(OBSERVED_AT / 1000) + 600,
        window: 'five_hour',
        usedPercent: 7,
        providerLabel: 'Codex',
        observedAt: OBSERVED_AT,
      },
    ]);
    expect(reading.understood).toBe(true);
  });

  it('reads a body that names its windows at the root and nowhere else', () => {
    // The same promotion with no container left behind. Refusing it for lack of a
    // `rate_limits` key would be refusing a body whose windows are right there.
    const reading = readCodexUsage(
      {
        primary_window: { used_percent: 7, limit_window_seconds: 18_000, reset_after_seconds: 60 },
      },
      OBSERVED_AT,
    );
    expect(reading.states.map((state) => state.window)).toEqual(['five_hour']);
    expect(reading.understood).toBe(true);
    // ...while a body that names no window anywhere is still somebody else's body.
    expect(readCodexUsage({ error: 'unauthorized' }, OBSERVED_AT).understood).toBe(false);
  });

  it('refuses a window renamed AND promoted, which the root audit is for', () => {
    // The container survives and parses, so nothing about the empty result says
    // "moved" — except the window-shaped stranger sitting next to it at the root.
    expect(
      understood({ rate_limits: {}, five_hour: { used_percent: 7, resets_at: 1_781_000_000 } }),
    ).toBe(false);
    // And the false-positive direction stays quiet: an added root metric next to
    // windows that DID parse is not evidence of anything.
    expect(understood({ ...USAGE_BODY, credits: { used_percent: 40 } })).toBe(true);
  });

  it('treats a zero remaining duration as a field nobody filled in', () => {
    // `reset_after_seconds: 0` taken literally ends the window at this instant,
    // and the client hides any row whose reset has passed — a window silently
    // absent from the meter with the probe reporting healthy. Unreadable is what
    // it actually is, and that is what raises the banner.
    const reading = readCodexUsage(
      { rate_limit: { primary_window: { used_percent: 42, reset_after_seconds: 0 } } },
      OBSERVED_AT,
    );
    expect(reading.states).toEqual([]);
    expect(reading.understood).toBe(false);
  });

  it('is blind to one window renamed while its sibling keeps its name', () => {
    // The price of the rule above. A container still naming `primary` is not read
    // as mid-rename, so a renamed `secondary` beside it is indistinguishable from
    // the single-window plan a weekly-only account genuinely has. The five-hour
    // meter stays correct and the weekly row is missing — the quieter half of the
    // trade that keeps `credits` from bannering every deployment.
    const reading = readCodexUsage(
      {
        rate_limits: {
          primary: { used_percent: 7, window_minutes: 300, resets_at: 1_781_000_000 },
          weekly: { used_percent: 95, window_minutes: 10080, resets_at: 1_781_083_600 },
        },
      },
      OBSERVED_AT,
    );
    expect(reading.states.map((state) => state.window)).toEqual(['five_hour']);
    expect(reading.understood).toBe(true);
  });

  it('is blind to a window whose name AND fields moved in the same release', () => {
    // The known hole, pinned so it stays a decision. Recognition is by field name,
    // so when those move too there is nothing left to recognise and this reads as
    // an idle account: a blank meter with a healthy probe. Closing it would mean
    // treating any object in the container as a window, which makes `credits` one
    // and puts a banner on every deployment instead.
    expect(
      understood({ rate_limits: { five_hour: { usage_pct: 7, ends_at: 1_781_000_000 } } }),
    ).toBe(true);
  });
});

describe('createCodexUsageService', () => {
  it('backs off well inside the window the attention banner waits out', () => {
    // The banner ignores any failure shorter than USAGE_PROBE_STALL_MS, so a
    // ceiling raised past it would silence the banner entirely with every test
    // still green. Several retries have to fit inside that window, not just one,
    // or the banner flaps between a stale `at` and a fresh failure — hence the
    // factor rather than a bare `<`. Pinned here, not left to two prose comments.
    expect(CODEX_USAGE_MAX_BACKOFF_MS * 4).toBeLessThanOrEqual(USAGE_PROBE_STALL_MS);
  });

  it('ignores a caller that asks to back off longer than the banner can wait', async () => {
    // The constant above only holds while nobody overrides it. The ceiling decides
    // how old `health().at` gets while the endpoint is already failing, and raised
    // past the banner's patience an override is not politeness, it is switching the
    // banner off with every other test still green.
    const { fetch, urls } = recordingFetch(() => ({ ok: false, status: 500, body: {} }));
    let clock = OBSERVED_AT;
    const service = createCodexUsageService({
      credentialProvider: () => Promise.resolve(CREDENTIAL),
      fetch,
      now: () => clock,
      // Large enough that a single doubling already asks for more than the ceiling.
      minRetryMs: CODEX_USAGE_MAX_BACKOFF_MS,
      maxBackoffMs: USAGE_PROBE_STALL_MS * 2,
    });

    await service.getLimits();
    expect(urls).toHaveLength(1);
    // Held for the ceiling, not for the hour that was asked for.
    clock += CODEX_USAGE_MAX_BACKOFF_MS - 1;
    await service.getLimits();
    expect(urls).toHaveLength(1);
    clock += 2;
    await service.getLimits();
    expect(urls).toHaveLength(2);
  });

  it('leaves a caller that asks to probe a busy endpoint less often alone', async () => {
    // The opposite override, and deliberately NOT clamped: a longer TTL is
    // politeness toward somebody else's endpoint. Clamping it would mean this file
    // deciding to send more requests than it was asked to — provoking exactly the
    // refusals the banner then reports. The cost is a later banner, and that trade
    // is the caller's to make.
    const { fetch, urls } = recordingFetch(() => ({ ok: true, status: 200, body: USAGE_BODY }));
    const { log, warnings } = collectingLogger();
    let clock = OBSERVED_AT;
    const service = createCodexUsageService({
      credentialProvider: () => Promise.resolve(CREDENTIAL),
      fetch,
      log,
      now: () => clock,
      ttlMs: USAGE_PROBE_STALL_MS * 2,
    });

    await service.getLimits();
    expect(urls).toHaveLength(1);
    clock += CODEX_USAGE_MAX_BACKOFF_MS + 1;
    await service.getLimits();
    expect(urls).toHaveLength(1);
    // And nothing is warned about: a healthy probe asked to run rarely is healthy.
    expect(warnings).toEqual([]);
  });

  it('sends the gateway credential as bearer plus account scope', async () => {
    const { fetch, urls, inits } = recordingFetch(() => ({
      ok: true,
      status: 200,
      body: USAGE_BODY,
    }));
    const service = createCodexUsageService({
      credentialProvider: () => Promise.resolve(CREDENTIAL),
      fetch,
      now: () => OBSERVED_AT,
    });

    const limits = await service.getLimits();
    expect(limits).toHaveLength(2);
    expect(limits[0]).toMatchObject({ providerLabel: 'Codex', observedAt: OBSERVED_AT });
    expect(urls).toEqual([USAGE_URL]);
    expect(inits[0]?.headers).toMatchObject({
      authorization: 'Bearer codex-token',
      'chatgpt-account-id': 'acct-1',
    });
  });

  it('is inert without a credential provider', async () => {
    const { fetch, urls } = recordingFetch(() => ({ ok: true, status: 200, body: USAGE_BODY }));
    const service = createCodexUsageService({ fetch, now: () => OBSERVED_AT });
    await expect(service.getLimits()).resolves.toEqual([]);
    expect(urls).toEqual([]);
  });

  it('falls back to the legacy path on 404 and pins the one that answered', async () => {
    const { fetch, urls } = recordingFetch((url) =>
      url === LEGACY_USAGE_URL
        ? { ok: true, status: 200, body: USAGE_BODY }
        : { ok: false, status: 404 },
    );
    let clock = OBSERVED_AT;
    const service = createCodexUsageService({
      credentialProvider: () => Promise.resolve(CREDENTIAL),
      fetch,
      now: () => clock,
      ttlMs: 1_000,
    });

    await expect(service.getLimits()).resolves.toHaveLength(2);
    expect(urls).toEqual([USAGE_URL, LEGACY_USAGE_URL]);
    clock += 2_000;
    await expect(service.getLimits()).resolves.toHaveLength(2);
    expect(urls).toEqual([USAGE_URL, LEGACY_USAGE_URL, LEGACY_USAGE_URL]);
  });

  it('serves the cached reading within the TTL and refetches after it', async () => {
    const { fetch, urls } = recordingFetch(() => ({ ok: true, status: 200, body: USAGE_BODY }));
    let clock = OBSERVED_AT;
    const service = createCodexUsageService({
      credentialProvider: () => Promise.resolve(CREDENTIAL),
      fetch,
      now: () => clock,
      ttlMs: 60_000,
    });

    await service.getLimits();
    clock += 30_000;
    await service.getLimits();
    expect(urls).toHaveLength(1);
    clock += 31_000;
    await service.getLimits();
    expect(urls).toHaveLength(2);
  });

  it('dedupes concurrent refreshes into a single request', async () => {
    const { fetch, urls } = recordingFetch(() => ({ ok: true, status: 200, body: USAGE_BODY }));
    const service = createCodexUsageService({
      credentialProvider: () => Promise.resolve(CREDENTIAL),
      fetch,
      now: () => OBSERVED_AT,
    });

    await Promise.all([service.getLimits(), service.getLimits(), service.getLimits()]);
    expect(urls).toHaveLength(1);
  });

  it('backs off after a failure, keeps the last good reading and never throws', async () => {
    let healthy = true;
    const { fetch, urls } = recordingFetch(() =>
      healthy ? { ok: true, status: 200, body: USAGE_BODY } : { ok: false, status: 429 },
    );
    const { log, warnings } = collectingLogger();
    let clock = OBSERVED_AT;
    const service = createCodexUsageService({
      credentialProvider: () => Promise.resolve(CREDENTIAL),
      fetch,
      log,
      now: () => clock,
      ttlMs: 1_000,
      minRetryMs: 10_000,
    });

    const good = await service.getLimits();
    expect(good).toHaveLength(2);
    healthy = false;
    clock += 2_000;
    await expect(service.getLimits()).resolves.toEqual(good);
    expect(warnings).toEqual(['non-2xx']);
    // Inside the backoff window no further request is made.
    clock += 5_000;
    await expect(service.getLimits()).resolves.toEqual(good);
    expect(urls).toHaveLength(2);
  });

  it('keeps a live meter rather than blanking it for a window it cannot place', async () => {
    // A named window that yields nothing usable — here, no reset in either
    // spelling. Reading that as "nothing is running" would replace a correct 95%
    // with an empty meter and call the probe healthy while doing it.
    let usable = true;
    const { fetch } = recordingFetch(() => ({
      ok: true,
      status: 200,
      body: usable ? USAGE_BODY : { rate_limits: { primary: { used_percent: 95 } } },
    }));
    const { log, warnings } = collectingLogger();
    let clock = OBSERVED_AT;
    const service = createCodexUsageService({
      credentialProvider: () => Promise.resolve(CREDENTIAL),
      fetch,
      log,
      now: () => clock,
      ttlMs: 1_000,
    });

    const good = await service.getLimits();
    expect(good).toHaveLength(2);
    usable = false;
    clock += 2_000;
    await expect(service.getLimits()).resolves.toEqual(good);
    expect(warnings).toEqual(['empty-parse']);
    // The reported shape names what actually moved. `['rate_limits']` alone would
    // name the one key that did NOT change and send the reader to a debugger.
    expect(service.health()).toMatchObject({
      state: 'unreadable',
      fields: ['rate_limits', 'rate_limits.primary'],
      windows: 0,
    });
  });

  it('serves the half it could read and still says the shape moved', async () => {
    // Only the weekly window's spelling changes. The five-hour meter is fine and
    // must keep updating; the weekly one has vanished, and "windows: 1, healthy"
    // is exactly the confident-wrong-value failure this probe exists to catch.
    let whole = true;
    const { fetch, urls } = recordingFetch(() => ({
      ok: true,
      status: 200,
      body: whole
        ? USAGE_BODY
        : {
            rate_limits: {
              secondary: { used_percent: 20, window_minutes: 300, resets_at: 1_781_002_000 },
              primary: { pct: 99 },
            },
          },
    }));
    const { log, warnings } = collectingLogger();
    let clock = OBSERVED_AT;
    const service = createCodexUsageService({
      credentialProvider: () => Promise.resolve(CREDENTIAL),
      fetch,
      log,
      now: () => clock,
      ttlMs: 1_000,
      minRetryMs: 10_000,
    });

    expect(await service.getLimits()).toHaveLength(2);
    whole = false;
    clock += 2_000;
    const partial = await service.getLimits();
    expect(partial.map((state) => [state.window, state.usedPercent])).toEqual([['five_hour', 20]]);
    expect(warnings).toEqual(['empty-parse']);
    // `windows: 1` is what stops the banner claiming this meter is stale: the row
    // it still shows was read from the account seconds ago.
    expect(service.health()).toMatchObject({ state: 'unreadable', windows: 1 });
    // A usable answer means the normal TTL cadence, not the failure backoff: the
    // half that works has to keep moving.
    clock += 2_000;
    await service.getLimits();
    expect(urls).toHaveLength(3);
    // ...which is exactly why the complaint must not repeat: nothing backs this
    // path off, so the same moved shape would warn every TTL until someone fixes
    // it, and a line that is always there is one nobody reads.
    expect(warnings).toEqual(['empty-parse']);
    clock += 2_000;
    whole = true;
    await service.getLimits();
    whole = false;
    clock += 2_000;
    await service.getLimits();
    // A clean read in between makes the next failure a new episode, worth saying.
    expect(warnings).toEqual(['empty-parse', 'empty-parse']);
  });

  it('blames the shape, not the network, when 2xx is not JSON at all', async () => {
    // What a login page or a Cloudflare interstitial served with status 200 lands
    // in. It is NOT unreachable — saying so points at the network, and whoever
    // reads that goes looking for a route that is fine. The reason in the log is
    // what separates "the endpoint moved" from "the endpoint returned HTML".
    const fetch: FetchLike = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error('Unexpected token < in JSON at position 0')),
      });
    const { log, warnings } = collectingLogger();
    const service = createCodexUsageService({
      credentialProvider: () => Promise.resolve(CREDENTIAL),
      fetch,
      log,
      now: () => OBSERVED_AT,
    });

    expect(await service.getLimits()).toEqual([]);
    expect(warnings).toEqual(['unparsable-body']);
    expect(service.health()).toMatchObject({
      state: 'unreadable',
      // No body to name fields from, and no pretending otherwise.
      fields: [],
      windows: 0,
      since: OBSERVED_AT,
    });
  });

  it('carries the outage start across a thrown request, not just a refused one', async () => {
    // The catch path is the one branch nothing else exercises, and it is what a
    // dropped control socket or a DNS failure lands in.
    const { fetch } = recordingFetch(() => {
      throw new Error('socket hang up');
    });
    const { log } = collectingLogger();
    let clock = OBSERVED_AT;
    const service = createCodexUsageService({
      credentialProvider: () => Promise.resolve(CREDENTIAL),
      fetch,
      log,
      now: () => clock,
      minRetryMs: 1_000,
      maxBackoffMs: 1_000,
    });

    await expect(service.getLimits()).resolves.toEqual([]);
    expect(service.health()).toEqual({ state: 'failed', at: OBSERVED_AT, since: OBSERVED_AT });
    clock += 5_000;
    await service.getLimits();
    // The attempt moved; the outage it belongs to did not.
    expect(service.health()).toEqual({
      state: 'failed',
      at: OBSERVED_AT + 5_000,
      since: OBSERVED_AT,
    });
  });

  it('survives a gateway that rejects the token read', async () => {
    const { fetch, urls } = recordingFetch(() => ({ ok: true, status: 200, body: USAGE_BODY }));
    const { log, warnings } = collectingLogger();
    const service = createCodexUsageService({
      credentialProvider: () => Promise.reject(new Error('gateway unavailable')),
      fetch,
      log,
      now: () => OBSERVED_AT,
    });

    await expect(service.getLimits()).resolves.toEqual([]);
    expect(urls).toEqual([]);
    expect(warnings).toEqual(['exception']);
  });

  it('reports an installed-but-empty account without a request failure', async () => {
    const { fetch } = recordingFetch(() => ({ ok: true, status: 200, body: { rate_limits: {} } }));
    const { log, warnings } = collectingLogger();
    const service = createCodexUsageService({
      credentialProvider: () => Promise.resolve(undefined),
      fetch,
      log,
      now: () => OBSERVED_AT,
    });

    await expect(service.getLimits()).resolves.toEqual([]);
    expect(warnings).toEqual(['no-credential']);
  });

  it('reports what the last attempt learned, so a dead probe cannot look healthy', async () => {
    const { fetch } = recordingFetch(() => ({ ok: false, status: 401 }));
    let clock = OBSERVED_AT;
    const service = createCodexUsageService({
      credentialProvider: () => Promise.resolve(CREDENTIAL),
      fetch,
      now: () => clock,
      minRetryMs: 1_000,
    });

    expect(service.health()).toEqual({ state: 'pending' });
    await service.getLimits();
    expect(service.health()).toEqual({
      state: 'http-error',
      status: 401,
      at: OBSERVED_AT,
      since: OBSERVED_AT,
    });
    // Still the same outage on the next attempt: `at` moves, `since` does not —
    // that difference is what lets a caller wait out a transient failure.
    clock += 5_000;
    await service.getLimits();
    expect(service.health()).toMatchObject({ at: clock, since: OBSERVED_AT });
  });

  it('names the fields of a 2xx body it could not read, and clears them once it can', async () => {
    let shape: unknown = { usage: { weekly: { pct: 95 } }, plan_type: 'plus' };
    const { fetch } = recordingFetch(() => ({ ok: true, status: 200, body: shape }));
    let clock = OBSERVED_AT;
    const service = createCodexUsageService({
      credentialProvider: () => Promise.resolve(CREDENTIAL),
      fetch,
      now: () => clock,
      ttlMs: 1_000,
      minRetryMs: 1_000,
    });

    await expect(service.getLimits()).resolves.toEqual([]);
    // Field NAMES only — never a value, so a diagnostic can't leak an account's
    // numbers — and enough to tell a changed shape from an idle account.
    expect(service.health()).toEqual({
      state: 'unreadable',
      windows: 0,
      fields: ['plan_type', 'usage'],
      at: OBSERVED_AT,
      since: OBSERVED_AT,
    });

    shape = USAGE_BODY;
    clock += 2_000;
    await expect(service.getLimits()).resolves.toHaveLength(2);
    expect(service.health()).toEqual({ state: 'ok', windows: 2, at: clock });
  });

  it('keeps the last good reading when the shape moves, and backs off', async () => {
    // A moved shape is a failure, not a reading: blanking the cache would drop the
    // meter to an even older per-session number, and treating it as a success
    // would re-poll a moved endpoint at full rate.
    let shape: unknown = USAGE_BODY;
    const { fetch, urls } = recordingFetch(() => ({ ok: true, status: 200, body: shape }));
    let clock = OBSERVED_AT;
    const service = createCodexUsageService({
      credentialProvider: () => Promise.resolve(CREDENTIAL),
      fetch,
      now: () => clock,
      ttlMs: 1_000,
      minRetryMs: 10_000,
    });

    const good = await service.getLimits();
    expect(good).toHaveLength(2);
    shape = { usage: {}, plan_type: 'plus' };
    clock += 2_000;
    await expect(service.getLimits()).resolves.toEqual(good);
    clock += 5_000;
    await expect(service.getLimits()).resolves.toEqual(good);
    expect(urls).toHaveLength(2);
  });

  it('does not let an empty husk of one spelling hide the other spelling moving', async () => {
    const { fetch } = recordingFetch(() => ({
      ok: true,
      status: 200,
      // `rate_limits` is window-free, so read alone it looks like an idle account —
      // but `rate_limit` was handed us a window we could not parse, which is the
      // shape change. The unreadable half has to win.
      body: { rate_limits: {}, rate_limit: { primary_window: { pct: 95 } } },
    }));
    const service = createCodexUsageService({
      credentialProvider: () => Promise.resolve(CREDENTIAL),
      fetch,
      now: () => OBSERVED_AT,
    });

    await expect(service.getLimits()).resolves.toEqual([]);
    expect(service.health()).toMatchObject({ state: 'unreadable' });
  });

  it('treats failing in a new way as one continuous outage', async () => {
    let mode: 'unreadable' | 'http' = 'unreadable';
    const { fetch } = recordingFetch(() =>
      mode === 'unreadable'
        ? { ok: true, status: 200, body: { usage: {} } }
        : { ok: false, status: 500 },
    );
    let clock = OBSERVED_AT;
    const service = createCodexUsageService({
      credentialProvider: () => Promise.resolve(CREDENTIAL),
      fetch,
      now: () => clock,
      minRetryMs: 1_000,
    });

    await service.getLimits();
    expect(service.health()).toMatchObject({ state: 'unreadable', since: OBSERVED_AT });
    mode = 'http';
    clock += 2_000;
    await service.getLimits();
    // A different symptom of the same outage — `since` must not restart, or the
    // stall threshold never elapses and the banner never appears.
    expect(service.health()).toMatchObject({ state: 'http-error', since: OBSERVED_AT });
  });

  it('calls an account with no window running idle, not unreadable', async () => {
    // The distinction the banner depends on: this body is one Verity READ, and it
    // said nothing is running. Calling it a failure would put a permanent notice
    // in front of an account that is simply not spending anything.
    const { fetch } = recordingFetch(() => ({
      ok: true,
      status: 200,
      body: { rate_limits: {}, plan_type: 'plus' },
    }));
    const service = createCodexUsageService({
      credentialProvider: () => Promise.resolve(CREDENTIAL),
      fetch,
      now: () => OBSERVED_AT,
    });

    await expect(service.getLimits()).resolves.toEqual([]);
    expect(service.health()).toEqual({ state: 'idle', at: OBSERVED_AT });
  });

  it('needs a second empty answer before it blanks a meter that had something', async () => {
    // "Nothing is running" and "the window moved to a name and fields Verity does
    // not know" produce the identical empty reading, and only one of them should
    // clear the meter. Waiting for a second one costs an idle account one refresh
    // and saves a live account a meter that empties for no stated reason.
    let empty = false;
    const { fetch } = recordingFetch(() => ({
      ok: true,
      status: 200,
      body: empty ? { rate_limits: {} } : USAGE_BODY,
    }));
    let clock = OBSERVED_AT;
    const service = createCodexUsageService({
      credentialProvider: () => Promise.resolve(CREDENTIAL),
      fetch,
      now: () => clock,
      ttlMs: 1_000,
    });

    expect(await service.getLimits()).toHaveLength(2);
    empty = true;
    clock += 2_000;
    expect(await service.getLimits()).toHaveLength(2);
    // Health describes what is being SERVED, not the reading being held back —
    // `idle` here would say "no window is running" over a meter showing two.
    expect(service.health()).toMatchObject({ state: 'ok', windows: 2 });
    clock += 2_000;
    expect(await service.getLimits()).toEqual([]);
    expect(service.health()).toMatchObject({ state: 'idle' });
    // And a meter that was already empty is not held up by the rule.
    clock += 2_000;
    expect(await service.getLimits()).toEqual([]);
  });

  it('ends at ok when the pinned URL 404s and the legacy one answers', async () => {
    // The failover is older than this health reporting, and a 404 on the way to a
    // successful read must not leave a failure verdict behind for the banner.
    const { fetch, urls } = recordingFetch((url) =>
      url === USAGE_URL ? { ok: false, status: 404 } : { ok: true, status: 200, body: USAGE_BODY },
    );
    const service = createCodexUsageService({
      credentialProvider: () => Promise.resolve(CREDENTIAL),
      fetch,
      now: () => OBSERVED_AT,
    });

    expect(await service.getLimits()).toHaveLength(2);
    expect(urls).toEqual([USAGE_URL, LEGACY_USAGE_URL]);
    expect(service.health()).toEqual({ state: 'ok', windows: 2, at: OBSERVED_AT });
  });

  it('remembers whether a vanished Codex login had ever worked', async () => {
    let credential: CodexUsageCredential | undefined = CREDENTIAL;
    const { fetch } = recordingFetch(() => ({ ok: true, status: 200, body: USAGE_BODY }));
    let clock = OBSERVED_AT;
    const service = createCodexUsageService({
      credentialProvider: () => Promise.resolve(credential),
      fetch,
      now: () => clock,
      ttlMs: 1_000,
    });

    await expect(service.getLimits()).resolves.toHaveLength(2);
    credential = undefined;
    clock += 2_000;
    await service.getLimits();
    // `everWorked` is what separates "no Codex login was ever installed" (a setup
    // state) from "the login this meter was reading is gone" (a frozen meter).
    expect(service.health()).toMatchObject({ state: 'no-credential', everWorked: true });
  });

  // A gateway that REFUSES the stored login is a different fact from one that
  // cannot be asked, and only the refusal has a remedy: sign in again. Folding it
  // into `failed` — which is what happened before this state existed — describes a
  // network problem to someone whose network is fine.
  it('separates a refused Codex sign-in from a gateway it could not reach', async () => {
    const { fetch, urls } = recordingFetch(() => ({ ok: true, status: 200, body: USAGE_BODY }));
    const { log, warnings } = collectingLogger();
    let clock = OBSERVED_AT;
    let reject = false;
    const service = createCodexUsageService({
      credentialProvider: () =>
        reject
          ? Promise.reject(new CodexSignInUnusableError())
          : Promise.resolve<CodexUsageCredential | undefined>(CREDENTIAL),
      fetch,
      log,
      now: () => clock,
      ttlMs: 1_000,
    });

    await expect(service.getLimits()).resolves.toHaveLength(2);
    const requested = urls.length;
    reject = true;
    clock += 2_000;
    // The meter keeps its last good reading rather than emptying: a refused login
    // does not make the number Verity already read untrue, only frozen.
    await expect(service.getLimits()).resolves.toHaveLength(2);
    expect(service.health()).toEqual({
      state: 'sign-in-rejected',
      at: OBSERVED_AT + 2_000,
      since: OBSERVED_AT + 2_000,
    });
    expect(warnings).toEqual(['sign-in-rejected']);
    // Refused before the request, so nothing was sent the second time.
    expect(urls).toHaveLength(requested);
  });

  // `since` is the age a caller fuses on, and a refusal is fused far shorter than
  // everything else. Letting a refusal inherit an older run would spend an unrelated
  // outage's age on that shorter fuse — the "wait for a second refusal" guarantee
  // gone, on the transition where a wrong banner is most likely.
  it('starts a fresh failure run when an outage turns into a refusal', async () => {
    const { fetch } = recordingFetch(() => ({ ok: true, status: 200, body: USAGE_BODY }));
    let clock = OBSERVED_AT;
    let mode: 'down' | 'refused' = 'down';
    const service = createCodexUsageService({
      credentialProvider: () =>
        Promise.reject(
          mode === 'down' ? new Error('control socket closed') : new CodexSignInUnusableError(),
        ),
      fetch,
      now: () => clock,
      ttlMs: 1_000,
    });

    await expect(service.getLimits()).resolves.toEqual([]);
    expect(service.health()).toMatchObject({ state: 'failed', since: OBSERVED_AT });
    // Past the backoff ceiling, so each step really does re-attempt.
    mode = 'refused';
    clock += CODEX_USAGE_MAX_BACKOFF_MS;
    await expect(service.getLimits()).resolves.toEqual([]);
    expect(service.health()).toMatchObject({
      state: 'sign-in-rejected',
      since: OBSERVED_AT + CODEX_USAGE_MAX_BACKOFF_MS,
    });

    // And the same in reverse, so a refusal cannot lend its age to an outage.
    mode = 'down';
    clock += CODEX_USAGE_MAX_BACKOFF_MS;
    await expect(service.getLimits()).resolves.toEqual([]);
    expect(service.health()).toMatchObject({
      state: 'failed',
      since: OBSERVED_AT + 2 * CODEX_USAGE_MAX_BACKOFF_MS,
    });
  });

  it('still treats an unexplained provider throw as a failure, not a refusal', async () => {
    // Only the typed error means "the gateway looked and said no". Anything else —
    // a socket error, a bug in the provider — is the probe not getting an answer.
    const { fetch } = recordingFetch(() => ({ ok: true, status: 200, body: USAGE_BODY }));
    const { log, warnings } = collectingLogger();
    const service = createCodexUsageService({
      credentialProvider: () => Promise.reject(new Error('control socket closed')),
      fetch,
      log,
      now: () => OBSERVED_AT,
    });

    await expect(service.getLimits()).resolves.toEqual([]);
    expect(warnings).toEqual(['exception']);
    expect(service.health()).toMatchObject({ state: 'failed' });
  });

  it('is unconfigured, not failing, when no credential provider is wired', () => {
    const { fetch } = recordingFetch(() => ({ ok: true, status: 200, body: USAGE_BODY }));
    expect(createCodexUsageService({ fetch, now: () => OBSERVED_AT }).health()).toEqual({
      state: 'unconfigured',
    });
  });
});
