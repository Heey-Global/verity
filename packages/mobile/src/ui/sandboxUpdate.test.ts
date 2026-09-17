import { describe, expect, it } from 'vitest';

import type { SandboxUpdate } from '../api.js';
import {
  isSecuritySandboxUpdate,
  sandboxUpdateIndicator,
  sandboxUpdateNeedsAttention,
  sandboxUpdateSummary,
} from './sandboxUpdate.js';

function update(overrides: Partial<SandboxUpdate> = {}): SandboxUpdate {
  return {
    state: 'available',
    kind: 'normal',
    category: 'software',
    reason: null,
    current: 'old',
    target: 'new',
    currentVersion: null,
    currentRevision: null,
    targetVersion: null,
    targetRevision: null,
    selfRepair: 'converging',
    turnBlocked: false,
    ...overrides,
  };
}

describe('sandboxUpdateNeedsAttention', () => {
  it('stays silent while Verity is still rebuilding the sandbox', () => {
    // The regression this guards: every Server restart re-creates the whole
    // fleet, so `available` alone would raise a flag on every project after
    // every update.
    expect(sandboxUpdateNeedsAttention(update({ selfRepair: 'converging' }))).toBe(false);
  });

  it('reports a sandbox whose automatic repair keeps failing', () => {
    expect(sandboxUpdateNeedsAttention(update({ selfRepair: 'stalled' }))).toBe(true);
  });

  it('reports a failed rebuild even when no container remains to inspect', () => {
    expect(sandboxUpdateNeedsAttention(update({ state: 'unknown', selfRepair: 'stalled' }))).toBe(
      true,
    );
  });

  it('reports an update a live turn has been holding off', () => {
    // The silent failure this guards: a project running an agent loop defers the
    // recreate on every reconcile tick, forever and by design. Read through
    // `selfRepair` alone this is indistinguishable from the fleet-wide minute
    // after a Server update — so the operator is shown "Verity is rebuilding
    // this sandbox" about a rebuild that will not start until they cancel the
    // turn, and the one case where there IS something to do is the one case that
    // draws nothing.
    expect(
      sandboxUpdateNeedsAttention(update({ turnBlocked: true, selfRepair: 'converging' })),
    ).toBe(true);
  });

  it('says nothing about an up-to-date or missing status', () => {
    expect(sandboxUpdateNeedsAttention(update({ state: 'current', selfRepair: 'stalled' }))).toBe(
      false,
    );
    expect(sandboxUpdateNeedsAttention(update({ state: 'current', turnBlocked: true }))).toBe(
      false,
    );
    expect(sandboxUpdateNeedsAttention(undefined)).toBe(false);
  });
});

describe('isSecuritySandboxUpdate', () => {
  it('accepts either the category or the older kind field', () => {
    expect(isSecuritySandboxUpdate(update({ category: 'security' }))).toBe(true);
    expect(isSecuritySandboxUpdate(update({ category: null, kind: 'security' }))).toBe(true);
    expect(isSecuritySandboxUpdate(update())).toBe(false);
    expect(isSecuritySandboxUpdate(undefined)).toBe(false);
  });

  it('lets the category overrule the older kind rather than or-ing the two', () => {
    // A Server that sets both is the newer one, and its `category` is the finer
    // verdict. Or-ing them would let `kind: 'security'` — which the old checker
    // set for anything it could not tell apart — re-flag an update the new field
    // deliberately classified as ordinary.
    expect(isSecuritySandboxUpdate(update({ category: 'software', kind: 'security' }))).toBe(false);
    expect(isSecuritySandboxUpdate(update({ category: 'configuration', kind: 'security' }))).toBe(
      false,
    );
    expect(isSecuritySandboxUpdate(update({ category: 'security', kind: 'normal' }))).toBe(true);
  });
});

describe('sandboxUpdateSummary', () => {
  it('has nothing to say about a current sandbox', () => {
    expect(sandboxUpdateSummary(update({ state: 'current' }))).toBeNull();
    expect(sandboxUpdateSummary(undefined)).toBeNull();
  });

  it('separates "Verity is on it" from "Verity gave up"', () => {
    expect(sandboxUpdateSummary(update({ selfRepair: 'converging' }))).toContain('rebuilding');
    expect(sandboxUpdateSummary(update({ selfRepair: 'stalled' }))).toContain('stuck');
  });

  it('explains a stalled repair whose missing container makes image state unknown', () => {
    expect(sandboxUpdateSummary(update({ state: 'unknown', selfRepair: 'stalled' }))).toContain(
      'could not be rebuilt',
    );
  });

  it('names a missed security fix as such in both states', () => {
    expect(sandboxUpdateSummary(update({ category: 'security' }))).toContain('Security update');
    expect(sandboxUpdateSummary(update({ category: 'security', selfRepair: 'stalled' }))).toContain(
      'Security update stuck',
    );
  });

  it('tells the operator what to do about a turn-blocked update instead of calling it stuck', () => {
    // The Server raises `selfRepair: 'stalled'` alongside `turnBlocked` — the
    // enum has no member of its own, so the existing glyph keeps working on
    // installed apps. Falling through to the `stalled` wording would therefore
    // describe a rebuild that has failed, which is the opposite of what happened:
    // nothing failed, and the operator holds the only thing that would move it.
    const blocked = sandboxUpdateSummary(update({ turnBlocked: true, selfRepair: 'stalled' }));
    expect(blocked).toBe('Update waiting for a turn to finish — cancel it to update now');
    expect(blocked).not.toContain('stuck');
    expect(
      sandboxUpdateSummary(
        update({ turnBlocked: true, selfRepair: 'stalled', category: 'security' }),
      ),
    ).toBe('Security update waiting for a turn to finish — cancel it to update now');
  });
});

describe('sandboxUpdateIndicator', () => {
  it('draws nothing while Verity is still rebuilding the sandbox', () => {
    // The regression the whole change exists to prevent: an icon on every project
    // for the first minute after every Server update.
    expect(sandboxUpdateIndicator(update({ selfRepair: 'converging' }))).toBeUndefined();
    expect(sandboxUpdateIndicator(update({ state: 'current' }))).toBeUndefined();
    expect(sandboxUpdateIndicator(update({ state: 'unknown' }))).toBeUndefined();
    expect(sandboxUpdateIndicator(undefined)).toBeUndefined();
  });

  it('warns once the repair has stopped happening', () => {
    expect(sandboxUpdateIndicator(update({ selfRepair: 'stalled' }))).toEqual({
      label: 'Sandbox update stuck',
      icon: 'alert-triangle',
      tone: 'attention',
    });
  });

  it('raises a stuck security update to the shield rather than a louder triangle', () => {
    expect(sandboxUpdateIndicator(update({ selfRepair: 'stalled', category: 'security' }))).toEqual(
      {
        label: 'Security update stuck',
        icon: 'shield',
        tone: 'danger',
      },
    );
  });

  it('draws a waiting glyph, not a fault glyph, while a turn holds the update off', () => {
    // A triangle here sends the operator looking for a broken sandbox. Nothing is
    // broken: the recreate is ready and is declining to end a turn it has no
    // business ending.
    expect(sandboxUpdateIndicator(update({ turnBlocked: true, selfRepair: 'stalled' }))).toEqual({
      label: 'Update waiting for a turn',
      icon: 'clock',
      tone: 'attention',
    });
  });

  it('keeps the shield on a security update a turn is holding off', () => {
    // The reason for the wait does not make the missing fix less urgent, so this
    // one deliberately does NOT soften to the clock.
    expect(
      sandboxUpdateIndicator(
        update({ turnBlocked: true, selfRepair: 'stalled', category: 'security' }),
      ),
    ).toEqual({ label: 'Security update waiting for a turn', icon: 'shield', tone: 'danger' });
  });
});
