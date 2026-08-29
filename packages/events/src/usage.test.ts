import { describe, expect, it } from 'vitest';
import type { AgentEvent } from './events.js';
import {
  aggregateUsage,
  codexRateLimitReached,
  codexRateLimitWindow,
  latestRateLimit,
  latestRateLimits,
} from './usage.js';

const result = (
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
): AgentEvent => ({
  t: 'result',
  usage: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens },
  stopReason: 'end_turn',
});

describe('aggregateUsage', () => {
  it('returns all-zero totals for an empty log', () => {
    expect(aggregateUsage([])).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      turns: 0,
    });
  });

  it('sums usage across result events and counts them as turns', () => {
    expect(aggregateUsage([result(100, 20, 5, 3), result(50, 10, 1, 2)])).toEqual({
      inputTokens: 150,
      outputTokens: 30,
      cacheReadTokens: 6,
      cacheCreationTokens: 5,
      turns: 2,
    });
  });

  it('ignores non-result events (only completed turns carry usage)', () => {
    const events: AgentEvent[] = [
      { t: 'session', id: 's1', model: 'm', worktree: '/wt/s1' },
      { t: 'text', delta: 'hello' },
      result(10, 4, 0, 0),
      { t: 'status', state: 'running' },
    ];
    expect(aggregateUsage(events)).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      turns: 1,
    });
  });
});

describe('latestRateLimit', () => {
  it('returns the latest active provider rate-limit state from the log', () => {
    expect(
      latestRateLimit([
        { t: 'rate_limit', status: 'rejected', resetsAt: 100, window: 'five_hour' },
        { t: 'text', delta: 'hello' },
        {
          t: 'rate_limit',
          status: 'allowed',
          resetsAt: 200,
          window: 'five_hour',
          providerLabel: 'Codex',
        },
      ]),
    ).toEqual({
      status: 'rejected',
      resetsAt: 100,
      window: 'five_hour',
      providerLabel: 'Claude',
    });
  });

  it('treats allowed as clearing only that provider', () => {
    expect(
      latestRateLimit([
        { t: 'rate_limit', status: 'rejected', resetsAt: 100, window: 'five_hour' },
        {
          t: 'rate_limit',
          status: 'allowed',
          resetsAt: 200,
          window: 'five_hour',
          providerLabel: 'Claude',
        },
      ]),
    ).toBeUndefined();
  });

  it('keeps multiple active provider limits and orders them by reset time', () => {
    const events: AgentEvent[] = [
      {
        t: 'rate_limit',
        status: 'rejected',
        resetsAt: 300,
        window: 'five_hour',
        providerLabel: 'Claude',
      },
      {
        t: 'rate_limit',
        status: 'rejected',
        resetsAt: 200,
        window: 'five_hour',
        providerLabel: 'Codex',
      },
    ];

    expect(latestRateLimits(events)).toEqual([
      { status: 'rejected', resetsAt: 300, window: 'five_hour', providerLabel: 'Claude' },
      { status: 'rejected', resetsAt: 200, window: 'five_hour', providerLabel: 'Codex' },
    ]);
    expect(latestRateLimit(events)).toEqual({
      status: 'rejected',
      resetsAt: 300,
      window: 'five_hour',
      providerLabel: 'Claude',
    });
  });

  it('keeps distinct windows for the same provider', () => {
    expect(
      latestRateLimits([
        {
          t: 'rate_limit',
          status: 'rejected',
          resetsAt: 100,
          window: 'five_hour',
          providerLabel: 'Claude',
        },
        {
          t: 'rate_limit',
          status: 'rejected',
          resetsAt: 200,
          window: 'weekly',
          providerLabel: 'Claude',
        },
      ]),
    ).toEqual([
      { status: 'rejected', resetsAt: 200, window: 'weekly', providerLabel: 'Claude' },
      { status: 'rejected', resetsAt: 100, window: 'five_hour', providerLabel: 'Claude' },
    ]);
  });

  it('keeps all-model and model-scoped weekly limits distinct', () => {
    expect(
      latestRateLimits([
        {
          t: 'rate_limit',
          status: 'allowed',
          resetsAt: 200,
          window: 'weekly',
          usedPercent: 90,
          providerLabel: 'Claude',
        },
        {
          t: 'rate_limit',
          status: 'allowed',
          resetsAt: 200,
          window: 'weekly',
          usedPercent: 0,
          scope: 'sonnet',
          providerLabel: 'Claude',
        },
      ]),
    ).toEqual([
      {
        status: 'allowed',
        resetsAt: 200,
        window: 'weekly',
        usedPercent: 0,
        scope: 'sonnet',
        providerLabel: 'Claude',
      },
      {
        status: 'allowed',
        resetsAt: 200,
        window: 'weekly',
        usedPercent: 90,
        providerLabel: 'Claude',
      },
    ]);
  });

  it('keeps allowed quota states when they carry usage for meter display', () => {
    expect(
      latestRateLimits([
        {
          t: 'rate_limit',
          status: 'allowed',
          resetsAt: 200,
          window: 'weekly',
          usedPercent: 76,
          providerLabel: 'Codex',
        },
      ]),
    ).toEqual([
      {
        status: 'allowed',
        resetsAt: 200,
        window: 'weekly',
        usedPercent: 76,
        providerLabel: 'Codex',
      },
    ]);
  });

  it('defaults older provider-less rate-limit events to Claude', () => {
    expect(
      latestRateLimit([
        { t: 'rate_limit', status: 'rejected', resetsAt: 100, window: 'five_hour' },
      ]),
    ).toEqual({
      status: 'rejected',
      resetsAt: 100,
      window: 'five_hour',
      providerLabel: 'Claude',
    });
  });

  it('returns undefined when no rate-limit event exists', () => {
    expect(latestRateLimit([result(1, 1, 0, 0)])).toBeUndefined();
  });
});

describe('codexRateLimitWindow', () => {
  it('identifies a window by its reported length', () => {
    expect(codexRateLimitWindow(7 * 24 * 60, 'five_hour')).toBe('weekly');
    expect(codexRateLimitWindow(5 * 60, 'weekly')).toBe('five_hour');
  });

  it('falls back to the positional meaning when the length is absent or unknown', () => {
    expect(codexRateLimitWindow(undefined, 'five_hour')).toBe('five_hour');
    expect(codexRateLimitWindow(0, 'weekly')).toBe('weekly');
    expect(codexRateLimitWindow(120, 'weekly')).toBe('weekly');
  });
});

describe('codexRateLimitReached', () => {
  it('treats a fully consumed window as reached regardless of the flag', () => {
    expect(codexRateLimitReached(undefined, 'primary', 'weekly', 100)).toBe(true);
  });

  it('reads the flag positionally or by window length', () => {
    expect(codexRateLimitReached('secondary', 'secondary', 'weekly', 10)).toBe(true);
    expect(codexRateLimitReached('secondary', 'primary', 'five_hour', 10)).toBe(false);
    expect(codexRateLimitReached('five_hour', 'primary', 'five_hour', 10)).toBe(true);
    expect(codexRateLimitReached('weekly', 'primary', 'weekly', 10)).toBe(true);
  });

  it('is not reached without a flag below the limit', () => {
    expect(codexRateLimitReached(undefined, 'primary', 'weekly', 99.9)).toBe(false);
  });
});
