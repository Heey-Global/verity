import { describe, expect, it } from 'vitest';
import type { ServerUpdateOperation, ServerUpdateStatus } from '../api.js';
import {
  describeServerUpdate,
  describeServerUpdatePanel,
  serverUpdatePollMs,
  serverUpdateAwaitsAttention,
  showsServerUpdatePanel,
} from './serverUpdate.js';

const release = {
  version: '1.4.0',
  serverImage: `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`,
  publishedAt: '2026-08-10T00:00:00.000Z',
};

const operation = (overrides: Partial<ServerUpdateOperation> = {}): ServerUpdateOperation => ({
  updateId: 'update-1',
  state: 'preparing',
  phase: 'pulling',
  step: 2,
  totalSteps: 14,
  generation: 3,
  previousDigest: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
  targetDigest: release.serverImage,
  failureCode: null,
  startedAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:05.000Z',
  ...overrides,
});

const status = (over: Partial<ServerUpdateStatus> = {}): ServerUpdateStatus =>
  ({ state: 'available', release, operation: null, ...over }) as ServerUpdateStatus;

describe('server update panel', () => {
  it('offers exactly the digest the server reported as available', () => {
    const view = describeServerUpdate(status());
    expect(view).toMatchObject({
      title: 'Version 1.4.0 available',
      action: 'Install 1.4.0',
      targetDigest: release.serverImage,
      busy: false,
      failed: false,
    });
  });

  // The release channel keeps reporting the running (old) version as out of
  // date for the whole operation, so availability alone would re-offer Install
  // and invite a competing request.
  it('never offers an action while an operation is in flight', () => {
    for (const state of ['preparing', 'prepared', 'activating', 'rolling-back'] as const) {
      const view = describeServerUpdate(status({ operation: operation({ state }) }));
      expect(view.action).toBeNull();
      expect(view.targetDigest).toBeNull();
      expect(view.busy).toBe(true);
    }
  });

  it('reports progress against the plan the operation is actually following', () => {
    expect(describeServerUpdate(status({ operation: operation() })).progress).toEqual({
      step: 2,
      total: 14,
    });
    const rollback = operation({ state: 'rolling-back', step: 1, totalSteps: 4 });
    expect(describeServerUpdate(status({ operation: rollback })).progress).toEqual({
      step: 1,
      total: 4,
    });
  });

  it('explains a failure by its closed code and stops polling', () => {
    const failed = operation({
      state: 'failed',
      phase: 'failed',
      failureCode: 'verifying-image-failed',
    });
    const view = describeServerUpdate(status({ operation: failed }));
    expect(view).toMatchObject({
      title: 'Update failed',
      detail: 'The new version failed signature verification.',
      busy: false,
      failed: true,
    });
    expect(serverUpdatePollMs(failed)).toBeNull();
  });

  it('falls back to a generic explanation for a code this build does not know', () => {
    const failed = operation({ state: 'failed', phase: 'failed', failureCode: 'unknown' });
    expect(describeServerUpdate(status({ operation: failed })).detail).toBe(
      'The update was stopped before anything changed.',
    );
  });

  it('reports a rollback as a completed recovery, not a silent success', () => {
    const view = describeServerUpdate(
      status({ operation: operation({ state: 'rolled-back', step: 4, totalSteps: 4 }) }),
    );
    expect(view).toMatchObject({ title: 'Update rolled back', failed: true, busy: false });
  });

  // The failed journal entry stays current until it is superseded, so the app
  // must send a different key to start a new attempt — with the first key the
  // server would answer from the journal and hand back the same failure.
  it('offers a retry after a failure under a key that does not rejoin it', () => {
    const first = describeServerUpdate(status());
    const failed = operation({ state: 'failed', phase: 'failed', failureCode: 'pulling-failed' });
    const retry = describeServerUpdate(status({ operation: failed }));
    expect(retry).toMatchObject({
      title: 'Update failed',
      action: 'Try again',
      targetDigest: release.serverImage,
      failed: true,
      busy: false,
    });
    expect(retry.idempotencyKey).not.toBe(first.idempotencyKey);
    // Pressing twice before the next poll must rejoin the attempt, not fork it.
    expect(describeServerUpdate(status({ operation: failed })).idempotencyKey).toBe(
      retry.idempotencyKey,
    );
    const again = operation({ state: 'failed', phase: 'failed', generation: 4 });
    expect(describeServerUpdate(status({ operation: again })).idempotencyKey).not.toBe(
      retry.idempotencyKey,
    );
  });

  it('offers a release published after the failure as a fresh install', () => {
    const failed = operation({
      state: 'rolled-back',
      targetDigest: `ghcr.io/heey-global/verity/verity-server@sha256:${'c'.repeat(64)}`,
    });
    expect(describeServerUpdate(status({ operation: failed }))).toMatchObject({
      title: 'Update rolled back',
      action: 'Install 1.4.0',
      targetDigest: release.serverImage,
    });
  });

  it('does not offer a retry the release channel cannot back', () => {
    const failed = operation({ state: 'failed', phase: 'failed' });
    const view = describeServerUpdate(
      status({ state: 'unreachable', reason: 'timeout', operation: failed }),
    );
    expect(view).toMatchObject({ title: 'Update failed', action: null, idempotencyKey: null });
  });

  it('returns to the availability view once the operation completed', () => {
    const done = operation({ state: 'completed', step: 14, totalSteps: 14 });
    expect(describeServerUpdate(status({ state: 'current', operation: done })).title).toBe(
      'Verity is up to date',
    );
    expect(serverUpdatePollMs(done)).toBeNull();
  });

  it('names the compatibility reason instead of offering an impossible install', () => {
    const view = describeServerUpdate(
      status({ state: 'incompatible', reasons: ['schema generation 2026-09-01 is too new'] }),
    );
    expect(view).toMatchObject({
      action: null,
      failed: true,
      detail: 'schema generation 2026-09-01 is too new',
    });
  });

  it('distinguishes an unreachable channel from an unmanaged deployment', () => {
    expect(describeServerUpdate(status({ state: 'unreachable', reason: 'timeout' }))).toMatchObject(
      {
        title: 'Update check unavailable',
        failed: false,
      },
    );
    expect(showsServerUpdatePanel(status({ state: 'unreachable', reason: 'timeout' }))).toBe(true);
    expect(showsServerUpdatePanel(status({ state: 'unsupported', reason: 'not managed' }))).toBe(
      false,
    );
  });

  // Activation is the window where the server goes away; a slow poll there
  // would leave the panel frozen exactly when it matters most.
  it('polls activation harder than preparation and not at all when idle', () => {
    expect(serverUpdatePollMs(operation({ state: 'preparing' }))).toBe(5_000);
    expect(serverUpdatePollMs(operation({ state: 'activating' }))).toBe(2_000);
    expect(serverUpdatePollMs(null)).toBeNull();
  });
});

describe('serverUpdateAwaitsAttention', () => {
  it('lights up for an available release', () => {
    expect(serverUpdateAwaitsAttention(status({ state: 'available', release }))).toBe(true);
  });

  it('stays dark when the deployment is current, unmanaged, or unreachable', () => {
    expect(serverUpdateAwaitsAttention(status({ state: 'current', release }))).toBe(false);
    expect(
      serverUpdateAwaitsAttention(status({ state: 'unsupported', reason: 'not managed' })),
    ).toBe(false);
    expect(serverUpdateAwaitsAttention(status({ state: 'unreachable', reason: 'timeout' }))).toBe(
      false,
    );
  });

  /**
   * A dot that stayed lit through the update would claim there is something to do
   * at the one moment there is not — the operation has its own surface in settings.
   */
  it('stays dark while an update is already running', () => {
    expect(
      serverUpdateAwaitsAttention(status({ state: 'available', release, operation: operation() })),
    ).toBe(false);
  });

  /**
   * The Updater keeps the last journal until the next accepted request archives
   * it, so "an operation exists" outlives every operation. Reading that as busy
   * would hide the dot permanently in the two cases that need it most: an attempt
   * that failed or rolled back, where the release is still there to retry, and an
   * install that completed long before the release now on offer.
   */
  it.each(['failed', 'rolled-back', 'completed'] as const)(
    'lights up again for a release still available after a %s operation',
    (state) => {
      expect(
        serverUpdateAwaitsAttention(
          status({ state: 'available', release, operation: operation({ state }) }),
        ),
      ).toBe(true);
    },
  );

  it('stays dark before the first answer arrives', () => {
    expect(serverUpdateAwaitsAttention(undefined)).toBe(false);
  });
});

describe('server update screen', () => {
  // Production case: 4.52.0 committed, companion step stopped since yesterday,
  // 4.52.1 published meanwhile. The screen must show both the stuck operation
  // and the newer release, each with its own way out.
  const newer = {
    version: '4.52.1',
    serverImage: `ghcr.io/heey-global/verity/verity-server@sha256:${'c'.repeat(64)}`,
    publishedAt: '2026-10-21T00:00:00.000Z',
  };
  const stuckOperation = operation({
    updateId: 'update-155',
    state: 'activating',
    phase: 'reconciling-companions',
    step: 15,
    totalSteps: 16,
    generation: 155,
    targetDigest: `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`,
    updatedAt: '2026-10-20T21:42:00.000Z',
  });
  const stuck = (over: Partial<ServerUpdateStatus> = {}) =>
    status({
      release: newer,
      operation: stuckOperation,
      installed: { version: '4.52.0', generation: 155 },
      stalled: true,
      recovery: { retry: true, supersede: true },
      attempt: {
        updateId: 'update-155',
        failures: 12,
        lastAttemptAt: '2026-10-21T11:55:00.000Z',
        lastError: { phase: 'reconciling-companions', cause: 'network-timeout' },
      },
      ...over,
    });

  it('shows the installed version above an available release with its notes', () => {
    const panel = describeServerUpdatePanel(
      status({ installed: { version: '1.3.0', generation: 2 } }),
    );
    expect(panel.installed).toEqual({ version: '1.3.0', publishedAt: null, upToDate: false });
    expect(panel.cards).toHaveLength(1);
    expect(panel.cards[0]).toMatchObject({
      status: { label: 'Available', tone: 'active' },
      action: { kind: 'install', label: 'Install 1.4.0', targetDigest: release.serverImage },
      notesVersion: '1.4.0',
    });
  });

  it('says up to date on the installed row alone instead of repeating it in a card', () => {
    const panel = describeServerUpdatePanel(
      status({ state: 'current', installed: { version: '1.4.0', generation: 7 } }),
    );
    expect(panel).toEqual({
      installed: { version: '1.4.0', publishedAt: release.publishedAt, upToDate: true },
      cards: [],
    });
  });

  it('does not call a server up to date while an operation on it is unfinished', () => {
    const panel = describeServerUpdatePanel(
      status({
        state: 'current',
        installed: { version: '1.4.0', generation: 7 },
        operation: operation({ state: 'activating', phase: 'reconciling-companions' }),
      }),
    );
    expect(panel.installed).toMatchObject({ upToDate: false, publishedAt: null });
    expect(panel.cards).toHaveLength(1);
  });

  it('shows progress for a moving operation and offers nothing', () => {
    const panel = describeServerUpdatePanel(
      status({
        operation: operation({
          state: 'activating',
          phase: 'switching-gateway',
          step: 12,
          totalSteps: 16,
        }),
      }),
    );
    expect(panel.cards).toEqual([
      expect.objectContaining({
        title: 'Installing 1.4.0',
        progress: { step: 12, total: 16, phase: 'Switching over' },
        action: null,
        notesVersion: '1.4.0',
      }),
    ]);
  });

  it('splits a stuck operation and a newer release into two actionable cards', () => {
    const [stuckCard, offer, ...rest] = describeServerUpdatePanel(stuck()).cards;
    expect(rest).toEqual([]);
    expect(stuckCard).toMatchObject({
      section: 'Unfinished update',
      status: { label: 'Stuck', tone: 'problem' },
      title: 'Update to 4.52.0 did not finish',
      stalled: {
        phase: 'Updating companions',
        step: 15,
        total: 16,
        since: '2026-10-20T21:42:00.000Z',
      },
      error: 'Updating companions failed: network timeout',
      action: { kind: 'retry', label: 'Retry 4.52.0', updateId: 'update-155', primary: false },
      // The stuck operation's notes would describe a version that is already running.
      notesVersion: null,
    });
    expect(offer).toMatchObject({
      section: 'Available',
      status: { label: 'New version' },
      title: 'Version 4.52.1 available',
      action: {
        kind: 'install',
        label: 'Install 4.52.1',
        targetDigest: newer.serverImage,
        primary: true,
      },
      notesVersion: '4.52.1',
    });
    // The install key must change with the operation so it is a new request.
    expect(offer?.action).toMatchObject({ idempotencyKey: expect.stringContaining('-g155') });
  });

  it('makes retry the primary action when nothing newer can replace the stuck update', () => {
    const cards = describeServerUpdatePanel(
      stuck({
        recovery: { retry: true, supersede: false },
        state: 'current',
      }),
    ).cards;
    expect(cards).toHaveLength(1);
    expect(cards[0]?.action).toMatchObject({ kind: 'retry', primary: true });
  });

  // Before commit the server says only retry is safe; the app must not invent
  // an install the Updater would refuse.
  it('offers only retry for an operation stuck before commit', () => {
    const cards = describeServerUpdatePanel(
      stuck({
        operation: { ...stuckOperation, phase: 'observing-candidate', step: 13 },
        recovery: { retry: true, supersede: false },
      }),
    ).cards;
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      stalled: { phase: 'Switching over' },
      action: { kind: 'retry' },
    });
  });

  // An older server sends none of the recovery fields: show what is known and
  // offer nothing it cannot do.
  it('offers no recovery through a server that reports none', () => {
    const cards = describeServerUpdatePanel(
      status({ release: newer, operation: stuckOperation }),
    ).cards;
    expect(cards).toHaveLength(1);
    // Without the server's verdict the app cannot call it stuck, and must not
    // offer an install the Updater would refuse with `operation-in-progress`.
    expect(cards[0]).toMatchObject({ progress: { phase: 'Updating companions' }, action: null });
  });

  it('keeps a failure on screen with the last error and a retry of the same release', () => {
    const failed = operation({ state: 'failed', phase: 'failed', failureCode: 'pulling-failed' });
    const panel = describeServerUpdatePanel(
      status({
        operation: failed,
        attempt: {
          updateId: failed.updateId,
          failures: 1,
          lastAttemptAt: '2026-08-10T00:00:05.000Z',
          lastError: { phase: 'pulling', cause: 'network-timeout' },
        },
      }),
    );
    expect(panel.cards).toEqual([
      expect.objectContaining({
        status: { label: 'Failed', tone: 'problem' },
        title: 'Update to 1.4.0 failed',
        error: 'Downloading failed: network timeout',
        action: expect.objectContaining({ kind: 'install', label: 'Try again' }),
        notesVersion: '1.4.0',
      }),
    ]);
  });

  it('separates a failure from a newer release published after it', () => {
    const failed = operation({
      state: 'failed',
      phase: 'failed',
      failureCode: 'pulling-failed',
      targetDigest: `ghcr.io/heey-global/verity/verity-server@sha256:${'9'.repeat(64)}`,
    });
    const cards = describeServerUpdatePanel(status({ operation: failed })).cards;
    expect(cards.map((card) => card.action?.kind ?? null)).toEqual([null, 'install']);
    expect(cards[1]).toMatchObject({ section: 'Available', notesVersion: '1.4.0' });
  });

  it('lights the badge for a stuck operation a newer release may replace', () => {
    expect(serverUpdateAwaitsAttention(stuck())).toBe(true);
    expect(
      serverUpdateAwaitsAttention(stuck({ recovery: { retry: true, supersede: false } })),
    ).toBe(false);
  });
});
