// When a project's Wiki maintenance runs. The failures worth guarding are the
// quiet ones: a run every pass during a burst of imports, a sleeping project
// woken for one note, a paused project started at all, a claim that holds the
// interval although no run started, and old occasions of a project without a
// Wiki that are never discarded.
import { WIKI_MAINTENANCE_SKILL } from '@verity/events';
import type { ProjectRecord } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';
import {
  WIKI_MAINTENANCE_PROMPT,
  decideWikiMaintenance,
  startWikiMaintenanceTrigger,
  WIKI_MAINTENANCE_RULES as RULES,
} from './wiki-maintenance-trigger.js';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-08T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms);

describe('decideWikiMaintenance', () => {
  it('supplies the trusted Skill without requiring a native tool to load it', () => {
    expect(WIKI_MAINTENANCE_PROMPT).toContain(WIKI_MAINTENANCE_SKILL);
    expect(WIKI_MAINTENANCE_PROMPT).toContain('already loaded');
    expect(WIKI_MAINTENANCE_PROMPT).toContain('verity_wiki_read_page');
  });

  const base = {
    state: 'active' as const,
    pending: { count: 3, oldestAt: ago(5 * HOUR), newestAt: ago(3 * HOUR) },
    lastRunAt: null,
    busy: false,
    now: NOW,
  };

  it('runs a settled active project', () => {
    expect(decideWikiMaintenance(base)).toEqual({ run: true });
  });

  it('never runs without open occasions', () => {
    const pending = { count: 0, oldestAt: null, newestAt: null };
    expect(decideWikiMaintenance({ ...base, pending })).toMatchObject({ reason: 'nothing_open' });
  });

  it('waits until a burst has settled, measured from its newest occasion', () => {
    const burst = { count: 10, oldestAt: ago(6 * HOUR), newestAt: ago(RULES.settleMs - 1) };
    expect(decideWikiMaintenance({ ...base, pending: burst })).toMatchObject({
      reason: 'settling',
    });
    const settled = { ...burst, newestAt: ago(RULES.settleMs) };
    expect(decideWikiMaintenance({ ...base, pending: settled }).run).toBe(true);
  });

  it('keeps the minimum interval between runs', () => {
    expect(
      decideWikiMaintenance({ ...base, lastRunAt: ago(RULES.minIntervalMs - 1) }),
    ).toMatchObject({ reason: 'interval' });
    expect(decideWikiMaintenance({ ...base, lastRunAt: ago(RULES.minIntervalMs) }).run).toBe(true);
  });

  it('wakes a sleeping project only for a backlog', () => {
    const sleeping = { ...base, state: 'sleeping' as const };
    expect(decideWikiMaintenance(sleeping)).toMatchObject({ reason: 'sleeping' });
    const old = { ...base.pending, oldestAt: ago(RULES.sleepingAgeMs) };
    expect(decideWikiMaintenance({ ...sleeping, pending: old }).run).toBe(true);
    const many = { ...base.pending, count: RULES.sleepingCount };
    expect(decideWikiMaintenance({ ...sleeping, pending: many }).run).toBe(true);
  });

  it.each(['absent', 'failed', 'cloning', 'waking'] as const)(
    'never starts a %s project',
    (state) => {
      const backlog = { count: 50, oldestAt: ago(30 * 24 * HOUR), newestAt: ago(24 * HOUR) };
      expect(decideWikiMaintenance({ ...base, state, pending: backlog })).toMatchObject({
        reason: 'state',
      });
    },
  );

  it('does not start while a session of the project works', () => {
    expect(decideWikiMaintenance({ ...base, busy: true })).toMatchObject({ reason: 'busy' });
  });
});

describe('startWikiMaintenanceTrigger', () => {
  function setup(
    options: {
      project?: Partial<ProjectRecord>;
      hasWiki?: boolean;
      busy?: boolean;
      session?: string | undefined;
      accepted?: boolean;
      claimed?: boolean;
      pending?: { count: number; oldestAt: Date | null; newestAt: Date | null };
    } = {},
  ) {
    const project = {
      id: 'p',
      state: 'active',
      kind: 'standard',
      hiddenAt: null,
      ...options.project,
    } as ProjectRecord;
    const previous = ago(2 * 24 * HOUR);
    const store = {
      getProject: vi.fn(async () => project),
      wikiOccasions: {
        projectsWithOpen: vi.fn(async () => ['p']),
        pending: vi.fn(
          async () =>
            options.pending ?? { count: 2, oldestAt: ago(5 * HOUR), newestAt: ago(3 * HOUR) },
        ),
        discardOpenBefore: vi.fn(async () => 1),
      },
      wikiMaintenance: {
        get: vi.fn(async () => ({ projectId: 'p', sessionId: null, lastRunAt: previous })),
        claimRun: vi.fn(async () => options.claimed ?? true),
        releaseRun: vi.fn(async () => undefined),
      },
    };
    const deps = {
      store: store as never,
      hasWiki: vi.fn(async () => options.hasWiki ?? true),
      isProjectBusy: vi.fn(async () => options.busy ?? false),
      ensureSession: vi.fn(async () => ('session' in options ? options.session : 'm')),
      dispatch: vi.fn(async () => ({ accepted: options.accepted ?? true })),
      log: { info: vi.fn(), warn: vi.fn() },
      now: () => NOW,
    };
    const trigger = startWikiMaintenanceTrigger(deps, { timer: false });
    return { trigger, deps, store, previous };
  }

  it('claims the slot and starts one run in the maintenance session', async () => {
    const { trigger, deps, store } = setup();
    await trigger.runOnce();
    expect(store.wikiMaintenance.claimRun).toHaveBeenCalledWith(
      'p',
      new Date(NOW),
      ago(RULES.minIntervalMs),
    );
    expect(deps.dispatch).toHaveBeenCalledWith('m');
    expect(store.wikiMaintenance.releaseRun).not.toHaveBeenCalled();
  });

  it('starts nothing when another server generation claimed the slot', async () => {
    const { trigger, deps } = setup({ claimed: false });
    await trigger.runOnce();
    expect(deps.ensureSession).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['the session cannot be created yet', { session: undefined }],
    ['the turn is not accepted', { accepted: false }],
  ])('gives the slot back when %s', async (_label, options) => {
    const { trigger, store, previous } = setup(options);
    await trigger.runOnce();
    expect(store.wikiMaintenance.releaseRun).toHaveBeenCalledWith('p', new Date(NOW), previous);
  });

  it('asks whether the project is busy only once nothing else says wait', async () => {
    const settling = setup({
      pending: { count: 1, oldestAt: ago(HOUR), newestAt: ago(HOUR) },
    });
    await settling.trigger.runOnce();
    expect(settling.deps.isProjectBusy).not.toHaveBeenCalled();
    const busy = setup({ busy: true });
    await busy.trigger.runOnce();
    expect(busy.deps.isProjectBusy).toHaveBeenCalledWith('p');
    expect(busy.store.wikiMaintenance.claimRun).not.toHaveBeenCalled();
  });

  it('discards old occasions of a project without a Wiki and starts nothing', async () => {
    const { trigger, deps, store } = setup({ hasWiki: false });
    await trigger.runOnce();
    expect(store.wikiOccasions.discardOpenBefore).toHaveBeenCalledWith(
      'p',
      ago(RULES.noWikiRetentionMs),
    );
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['deleted', { hiddenAt: new Date() }],
    ['Verity Control', { kind: 'control_plane' }],
  ])('leaves a %s project alone', async (_label, project) => {
    const { trigger, deps, store } = setup({ project: project as Partial<ProjectRecord> });
    await trigger.runOnce();
    expect(deps.hasWiki).not.toHaveBeenCalled();
    expect(store.wikiMaintenance.claimRun).not.toHaveBeenCalled();
  });

  it('keeps checking other projects when one fails', async () => {
    const { trigger, deps, store } = setup();
    store.wikiOccasions.projectsWithOpen.mockResolvedValue(['broken', 'p']);
    store.getProject.mockImplementationOnce(async () => {
      throw new Error('offline');
    });
    await trigger.runOnce();
    expect(deps.log.warn).toHaveBeenCalled();
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
  });
});
