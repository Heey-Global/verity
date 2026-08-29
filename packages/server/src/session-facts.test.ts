import { describe, expect, it } from 'vitest';

import {
  collectSessionFacts,
  newestWithinLimit,
  SESSION_LISTING_HYDRATION_LIMIT,
  type SessionFactsRow,
} from './session-facts.js';

function rows(count: number, project = 'k8s'): SessionFactsRow[] {
  return Array.from({ length: count }, (_, index) => ({
    sessionId: `sess-${String(index)}`,
    projectId: project,
    worktree: `/work/.verity-sessions/agent-${String(index)}`,
  }));
}

/**
 * A source that records what it was asked to read, so a test can assert the cost of a listing
 * and not only its result — the reason this collector was pulled out of the route at all.
 */
function source(
  all: SessionFactsRow[],
  overrides: {
    dead?: ReadonlySet<string>;
    stat?: () => Promise<void>;
    summarize?: (row: SessionFactsRow) => Promise<string>;
  } = {},
) {
  const statted: string[] = [];
  const hydrated: string[] = [];
  const peak = { stat: 0, summarize: 0 };
  let statInFlight = 0;
  let summarizeInFlight = 0;
  return {
    statted,
    hydrated,
    peak,
    source: {
      listSessions: () => Promise.resolve(all),
      worktreeExists: async (worktree: string) => {
        statted.push(worktree);
        peak.stat = Math.max(peak.stat, ++statInFlight);
        try {
          await overrides.stat?.();
          return !(overrides.dead ?? new Set()).has(worktree);
        } finally {
          statInFlight--;
        }
      },
      summarize: async (row: SessionFactsRow) => {
        hydrated.push(row.sessionId);
        peak.summarize = Math.max(peak.summarize, ++summarizeInFlight);
        try {
          return await (overrides.summarize?.(row) ?? Promise.resolve(`summary:${row.sessionId}`));
        } finally {
          summarizeInFlight--;
        }
      },
    },
  };
}

/** Let every already-queued microtask and timer callback run. */
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('collectSessionFacts', () => {
  it('never reads a session the caller narrowed away — neither its worktree nor its log', async () => {
    // The whole cost argument for the listing rests on this order. A narrow that only filtered
    // the finished result would still have paid for every session in the install.
    const probe = source(rows(6));
    const { summaries } = await collectSessionFacts(
      probe.source,
      (candidate) => candidate.sessionId === 'sess-4',
      true,
      undefined,
    );
    expect(summaries).toEqual(['summary:sess-4']);
    expect(probe.statted).toEqual(['/work/.verity-sessions/agent-4']);
    expect(probe.hydrated).toEqual(['sess-4']);
  });

  it('drops sessions whose worktree is gone before paying to hydrate them', async () => {
    const probe = source(rows(4), {
      dead: new Set(['/work/.verity-sessions/agent-1', '/work/.verity-sessions/agent-2']),
    });
    const { summaries } = await collectSessionFacts(probe.source, () => true, true, undefined);
    expect(summaries).toEqual(['summary:sess-0', 'summary:sess-3']);
    // Statted all four, hydrated only the two that survived: the check is what keeps a dead
    // session from costing a full event-log read on every listing for the life of the install.
    expect(probe.statted).toHaveLength(4);
    expect(probe.hydrated).toEqual(['sess-0', 'sess-3']);
  });

  it('skips the worktree check entirely when the caller asked to see dead sessions too', async () => {
    const probe = source(rows(3), { dead: new Set(['/work/.verity-sessions/agent-0']) });
    const { summaries } = await collectSessionFacts(probe.source, () => true, false, undefined);
    expect(summaries).toHaveLength(3);
    expect(probe.statted).toEqual([]);
  });

  it('caps to the newest rows and reports how many it left out', async () => {
    // `listSessions` orders oldest-first, so the tail is the newest — the sessions a handoff
    // is looking for. And the cap bounds hydration, not just the response: the rows it drops
    // are never read.
    const probe = source(rows(10));
    const { summaries, omitted } = await collectSessionFacts(probe.source, () => true, true, 3);
    expect(summaries).toEqual(['summary:sess-7', 'summary:sess-8', 'summary:sess-9']);
    expect(omitted).toBe(7);
    expect(probe.hydrated).toEqual(['sess-7', 'sess-8', 'sess-9']);
  });

  it('reports nothing omitted when the cap does not bite, and never caps without one', async () => {
    const capped = source(rows(3));
    expect((await collectSessionFacts(capped.source, () => true, true, 50)).omitted).toBe(0);
    // `undefined` is what the handoff passes: it must see every eligible session, because a
    // cap there could hide the second one in a project and turn a correctly refused ambiguous
    // handoff into a confident delivery to the wrong session.
    const uncapped = source(rows(120));
    const { summaries, omitted } = await collectSessionFacts(
      uncapped.source,
      () => true,
      true,
      undefined,
    );
    expect(summaries).toHaveLength(120);
    expect(omitted).toBe(0);
  });

  it('holds the pool bound over both file reads, so a large fleet cannot exhaust descriptors', async () => {
    // Both steps open one file per session, and the fleet is not bounded by anything the
    // caller wrote — a `Promise.all` over either is how a busy install runs out of
    // descriptors. Asserted by holding every call open at once and looking at the peak.
    let openStats!: () => void;
    let openLogs!: () => void;
    const stats = new Promise<void>((resolve) => {
      openStats = () => resolve();
    });
    const logs = new Promise<void>((resolve) => {
      openLogs = () => resolve();
    });
    const probe = source(rows(40), {
      stat: () => stats,
      summarize: async (row) => {
        await logs;
        return `summary:${row.sessionId}`;
      },
    });

    const pending = collectSessionFacts(probe.source, () => true, true, undefined);
    await settle();
    expect(probe.statted).toHaveLength(SESSION_LISTING_HYDRATION_LIMIT);
    openStats();
    await settle();
    expect(probe.hydrated).toHaveLength(SESSION_LISTING_HYDRATION_LIMIT);
    openLogs();
    await pending;

    expect(probe.peak.stat).toBe(SESSION_LISTING_HYDRATION_LIMIT);
    expect(probe.peak.summarize).toBe(SESSION_LISTING_HYDRATION_LIMIT);
    // And more than one at a time: the check used to run sequentially, which bounded the
    // descriptors but made the listing's latency linear in a table that only grows.
    expect(SESSION_LISTING_HYDRATION_LIMIT).toBeGreaterThan(1);
  });

  it('returns rows in table order, not in the order their logs happened to read', async () => {
    // Otherwise the same fleet answers differently between two calls, and `omitted` would be
    // reporting against a set the caller cannot line up with the previous one.
    const delays = new Map([
      ['sess-0', 30],
      ['sess-1', 0],
      ['sess-2', 15],
    ]);
    const probe = source(rows(3), {
      summarize: (row) =>
        new Promise((resolve) =>
          setTimeout(() => resolve(`summary:${row.sessionId}`), delays.get(row.sessionId)),
        ),
    });
    const { summaries } = await collectSessionFacts(probe.source, () => true, true, undefined);
    expect(summaries).toEqual(['summary:sess-0', 'summary:sess-1', 'summary:sess-2']);
  });

  it('fails the whole listing when one log cannot be read', async () => {
    // Deliberately not "drop that session and answer with the rest". The caller reads the
    // result as the fleet, so a silently short list would have it conclude that a session it
    // is looking for does not exist — and a handoff addressed by project would then see one
    // eligible target where there are two.
    const probe = source(rows(5), {
      summarize: (row) =>
        row.sessionId === 'sess-2'
          ? Promise.reject(new Error('event log is corrupt'))
          : Promise.resolve(`summary:${row.sessionId}`),
    });
    await expect(collectSessionFacts(probe.source, () => true, true, undefined)).rejects.toThrow(
      'event log is corrupt',
    );
  });
});

describe('newestWithinLimit', () => {
  it('keeps the newest rows when the cap bites, and every row when it does not', () => {
    // The rows arrive oldest-first. Keeping the head would answer a large install with its
    // least relevant sessions while looking exactly like a complete answer, so this is the
    // one line of the cap worth pinning.
    expect(newestWithinLimit(['a', 'b', 'c', 'd'], 2)).toEqual({ kept: ['c', 'd'], omitted: 2 });
    expect(newestWithinLimit(['a', 'b'], 2)).toEqual({ kept: ['a', 'b'], omitted: 0 });
    expect(newestWithinLimit(['a', 'b'], 5)).toEqual({ kept: ['a', 'b'], omitted: 0 });
    expect(newestWithinLimit([], 2)).toEqual({ kept: [], omitted: 0 });
    // The handoff's case: no cap at all.
    expect(newestWithinLimit(['a', 'b', 'c'], undefined)).toEqual({
      kept: ['a', 'b', 'c'],
      omitted: 0,
    });
  });
});
