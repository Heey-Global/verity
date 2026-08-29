import { describe, expect, it } from 'vitest';
import type { ServerUpdateOperation, ServerUpdateStatus } from '../api.js';
import {
  describeServerUpdate,
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
