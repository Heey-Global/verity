import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCodexModelCatalog, startCodexModelCatalog } from './codex-model-catalog.js';

afterEach(() => vi.useRealTimers());

describe('parseCodexModelCatalog', () => {
  it('returns only unique models visible in the Codex picker', () => {
    expect(
      parseCodexModelCatalog({
        models: [
          { slug: 'gpt-5.6-sol', visibility: 'list' },
          { slug: 'gpt-5.4', visibility: 'hide' },
          { slug: 'gpt-5.6-sol', visibility: 'list' },
          { slug: 'gpt-5.6-terra', visibility: 'list' },
          { slug: '', visibility: 'list' },
        ],
      }),
    ).toEqual(['codex/gpt-5.6-sol', 'codex/gpt-5.6-terra']);
  });

  it('orders visible models by numeric priority and keeps catalog order as a fallback', () => {
    expect(
      parseCodexModelCatalog({
        models: [
          { slug: 'unranked-a', visibility: 'list' },
          { slug: 'terra', visibility: 'list', priority: 2 },
          { slug: 'invalid-priority', visibility: 'list', priority: '1' },
          { slug: 'negative-priority', visibility: 'list', priority: -1 },
          { slug: 'sol', visibility: 'list', priority: 1 },
          { slug: 'unranked-b', visibility: 'list' },
        ],
      }),
    ).toEqual([
      'codex/sol',
      'codex/terra',
      'codex/unranked-a',
      'codex/invalid-priority',
      'codex/negative-priority',
      'codex/unranked-b',
    ]);
  });

  it('degrades invalid catalog responses to an empty list', () => {
    expect(parseCodexModelCatalog(null)).toEqual([]);
    expect(parseCodexModelCatalog({ models: 'invalid' })).toEqual([]);
  });
});

describe('startCodexModelCatalog', () => {
  it('retains the fallback and refreshes on the configured interval', async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockResolvedValue(['codex/gpt-5.6-sol']);
    const catalog = startCodexModelCatalog({
      load,
      fallback: ['codex/default'],
      intervalMs: 100,
    });

    expect(catalog.list()).toEqual(['codex/default']);
    await catalog.refresh();
    expect(catalog.list()).toEqual(['codex/default', 'codex/gpt-5.6-sol']);
    await vi.advanceTimersByTimeAsync(100);
    expect(load).toHaveBeenCalledTimes(2);
    await catalog.close();
  });

  it('replaces the bundled seed once an account load succeeds', async () => {
    // Mirrors the sealed-boot → unlock flow: the first refresh seeds from the bundled
    // catalog while the store is sealed, the second loads the account-current catalog
    // after unlock. The stale bundled id must drop; the fallback (`codex/default`) stays.
    const load = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce(['codex/gpt-5.6-sol'])
      .mockResolvedValueOnce(['codex/gpt-5.6-terra', 'codex/gpt-5.6-luna']);
    const catalog = startCodexModelCatalog({
      load,
      fallback: ['codex/default'],
      intervalMs: 60_000,
    });

    await catalog.refresh();
    expect(catalog.list()).toEqual(['codex/default', 'codex/gpt-5.6-sol']);
    await catalog.refresh();
    expect(catalog.list()).toEqual(['codex/default', 'codex/gpt-5.6-terra', 'codex/gpt-5.6-luna']);
    await catalog.close();
  });

  it('keeps the bundled seed when a later account load fails', async () => {
    const onError = vi.fn();
    const load = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce(['codex/gpt-5.6-sol'])
      .mockRejectedValueOnce(new Error('codex debug models: exit 1'));
    const catalog = startCodexModelCatalog({
      load,
      fallback: ['codex/default'],
      intervalMs: 60_000,
      onError,
    });

    await catalog.refresh();
    await catalog.refresh();
    expect(catalog.list()).toEqual(['codex/default', 'codex/gpt-5.6-sol']);
    expect(onError).toHaveBeenCalledOnce();
    await catalog.close();
  });

  it('keeps the last successful list when a refresh fails', async () => {
    const onError = vi.fn();
    const load = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce(['codex/gpt-5.6-terra'])
      .mockRejectedValueOnce(new Error('offline'));
    const catalog = startCodexModelCatalog({
      load,
      fallback: ['codex/default'],
      intervalMs: 60_000,
      onError,
    });

    await catalog.refresh();
    await catalog.refresh();
    expect(catalog.list()).toEqual(['codex/default', 'codex/gpt-5.6-terra']);
    expect(onError).toHaveBeenCalledOnce();
    await catalog.close();
  });
});
