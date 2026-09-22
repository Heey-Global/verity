import { describe, expect, it } from 'vitest';
import { PROJECT_IMAGE_REBUILDING_WARNING } from '@verity/events';

import {
  UNAVAILABLE_PROJECT_BADGE,
  UNTRACKED_PROJECT_BADGE,
  projectBadge,
  projectLifecycleBadge,
  projectNeedsRepair,
  sandboxUpdateConverging,
} from './projectBadge.js';
import { sandboxUpdateNeedsAttention } from './sandboxUpdate.js';

describe('projectBadge', () => {
  it('reports a running container as green and settled', () => {
    expect(projectBadge({ state: 'active' })).toEqual({
      label: 'Running',
      tone: 'done',
      pulsing: false,
      needsRepair: false,
    });
  });

  it('pulses magenta while Verity works on the container', () => {
    for (const state of ['cloning', 'container_starting'] as const) {
      const badge = projectBadge({ state });
      expect(badge.tone).toBe('working');
      expect(badge.pulsing).toBe(true);
      expect(badge.needsRepair).toBe(false);
    }
  });

  it.each([
    ['sleeping_starting', 'Pausing secure workspace…', 'working', true],
    ['sleeping', 'Sleeping', 'idle', false],
    ['waking', 'Waking secure workspace…', 'working', true],
  ] as const)(
    'uses lifecycleState %s instead of its legacy active projection',
    (lifecycleState, label, tone, pulsing) => {
      expect(projectBadge({ state: 'active', lifecycleState })).toMatchObject({
        label,
        tone,
        pulsing,
        needsRepair: false,
      });
    },
  );

  it('uses a compact sleep symbol for a sleeping project', () => {
    expect(projectBadge({ state: 'active', lifecycleState: 'sleeping' })).toMatchObject({
      label: 'Sleeping',
      symbol: 'sleep',
      tone: 'idle',
      pulsing: false,
    });
  });

  it('reports an active project with an image rebuild as working', () => {
    expect(
      projectBadge({
        state: 'active',
        provisionWarning: PROJECT_IMAGE_REBUILDING_WARNING,
      }),
    ).toEqual({
      label: 'Rebuilding secure workspace…',
      tone: 'working',
      pulsing: true,
      needsRepair: false,
    });
  });

  // The reconciler writes `state: 'failed'` and clears nothing else, so a
  // container that died during an image rebuild keeps the warning that was true
  // a moment ago. Reading the warning first made that project report a confident
  // magenta "Rebuilding secure workspace…" — pulsing, no Repair offered — for a
  // sandbox that was gone and needed one press to come back.
  it('keeps asking for repair even while a rebuild warning is still attached', () => {
    const badge = projectBadge({
      state: 'failed',
      provisionWarning: PROJECT_IMAGE_REBUILDING_WARNING,
      sandboxUpdate: { state: 'available', selfRepair: 'converging' } as never,
    });
    expect(badge).toMatchObject({ tone: 'danger', pulsing: false, needsRepair: true });
    expect(
      projectNeedsRepair({ state: 'failed', provisionWarning: PROJECT_IMAGE_REBUILDING_WARNING }),
    ).toBe(true);
  });

  // The wizard numbers its steps from the lifecycle state, so its label has to
  // come from the same place. Background work does not advance a step: a cloning
  // project with a rebuild in flight labelled "Rebuilding secure workspace…"
  // would number one thing and name another.
  it('reports the lifecycle alone when asked for it, ignoring background work', () => {
    const cloningDuringRebuild = {
      state: 'cloning',
      provisionWarning: PROJECT_IMAGE_REBUILDING_WARNING,
      sandboxUpdate: { state: 'available', selfRepair: 'converging' } as never,
    } as const;
    expect(projectLifecycleBadge(cloningDuringRebuild).label).toBe('Preparing repository…');
    expect(projectBadge(cloningDuringRebuild).label).toBe('Rebuilding secure workspace…');
    // The pending-setup substitution belongs to the lifecycle, not the overrides.
    expect(projectLifecycleBadge({ state: 'absent', setupStatus: 'pending' }).label).toBe(
      'Preparing secure workspace…',
    );
  });

  // The whole set is one sentence pattern, and it is the only place the overview
  // reminds anyone their code runs in an isolated sandbox. A state that invents
  // its own noun ("project", "container", "sandbox") reads as a different
  // subsystem reporting — which is how "Waking…" and "Waking secure workspace…"
  // ended up on the same row, next to each other.
  it('says the same thing about the workspace in every transitional state', () => {
    const transitional = [
      projectBadge({ state: 'container_starting' }),
      projectBadge({ state: 'active', lifecycleState: 'waking' }),
      projectBadge({ state: 'active', lifecycleState: 'sleeping_starting' }),
      projectBadge({ state: 'absent', setupStatus: 'pending' }),
      projectBadge({ state: 'active', provisionWarning: PROJECT_IMAGE_REBUILDING_WARNING }),
      projectBadge({
        state: 'active',
        sandboxUpdate: { state: 'available', selfRepair: 'converging' } as never,
      }),
    ];
    for (const badge of transitional) {
      expect(badge).toMatchObject({ tone: 'working', pulsing: true });
      expect(badge.label).toMatch(/^[A-Z][a-z]+ secure workspace…$/);
    }
    // Distinct verbs: a single pattern is only useful if the rows still differ.
    expect(new Set(transitional.map(({ label }) => label)).size).toBe(transitional.length);
    // `cloning` is the one deliberate exception, and it is not an oversight in the
    // pattern above: the workspace does not exist yet at that point, so naming it
    // would report a sandbox nobody has started. It says what is actually being
    // fetched instead, and is the step immediately before `Starting …`.
    expect(projectBadge({ state: 'cloning' })).toMatchObject({
      label: 'Preparing repository…',
      tone: 'working',
      pulsing: true,
    });
  });

  // Two signals, one condition each, and the row draws exactly one of them: the
  // magenta pulse for an update Verity is closing by itself, the action glyph for
  // one that has stopped. The overview used to show a spinner for BOTH — including
  // for `turnBlocked`, where the spinner promised progress that was not happening
  // — and deleting it leaves the glyph as the only report of the stopped cases.
  // So the predicates have to stay exact complements over every pending update:
  // an overlap draws two progress vocabularies on one row again, and a gap leaves
  // a stuck sandbox reporting nothing at all.
  it('splits every pending update between the pulse and the action glyph', () => {
    const states = ['current', 'available', 'unknown'] as const;
    const repairs = ['converging', 'stalled'] as const;
    for (const state of states) {
      for (const selfRepair of repairs) {
        for (const turnBlocked of [false, true]) {
          const update = { state, selfRepair, turnBlocked } as never;
          const pulses = sandboxUpdateConverging(update);
          const needsAction = sandboxUpdateNeedsAttention(update);
          const combination = `${state}/${selfRepair}/${String(turnBlocked)}`;
          expect(pulses && needsAction, `both signals for ${combination}`).toBe(false);
          // `unknown` carries no claim that an update exists, so silence is the
          // honest answer there; `current` has nothing to report either.
          if (state === 'available')
            expect(pulses || needsAction, `no signal for ${combination}`).toBe(true);
        }
      }
    }
  });

  // The green "Running" dot with a grey spinner beside it was the row saying two
  // different things about the same container. A self-repairing update IS Verity
  // working on it, so it takes the one working signal the app has.
  it('pulses while Verity rebuilds a running container onto a new image', () => {
    const converging = { state: 'available', selfRepair: 'converging' } as never;
    expect(projectBadge({ state: 'active', sandboxUpdate: converging })).toMatchObject({
      label: 'Updating secure workspace…',
      tone: 'working',
      pulsing: true,
    });

    // Only over a settled container. A transition the operator just triggered is
    // the more immediate answer, and a broken one must not be painted over.
    expect(
      projectBadge({ state: 'active', lifecycleState: 'waking', sandboxUpdate: converging }),
    ).toMatchObject({ label: 'Waking secure workspace…' });
    expect(projectBadge({ state: 'failed', sandboxUpdate: converging })).toMatchObject({
      tone: 'danger',
      needsRepair: true,
    });
    expect(
      projectBadge({ state: 'active', lifecycleState: 'sleeping', sandboxUpdate: converging }),
    ).toMatchObject({ label: 'Sleeping', tone: 'idle' });
  });

  // `stalled` and `turnBlocked` are NOT work in progress — nothing on the Verity
  // side will move them, and they keep the row's action glyph instead. Pulsing
  // for them would promise a rebuild that is not running.
  it('does not pulse for an update that has stopped moving on its own', () => {
    for (const update of [
      { state: 'available', selfRepair: 'stalled' },
      { state: 'available', selfRepair: 'converging', turnBlocked: true },
      { state: 'current', selfRepair: 'converging' },
    ]) {
      expect(projectBadge({ state: 'active', sandboxUpdate: update as never })).toMatchObject({
        label: 'Running',
        pulsing: false,
      });
    }
  });

  it('treats a pending setup on an unprovisioned project as work in progress', () => {
    expect(projectBadge({ state: 'absent', setupStatus: 'pending' })).toMatchObject({
      tone: 'working',
      pulsing: true,
    });
  });

  it('reads a deliberately paused project as idle, not broken', () => {
    const badge = projectBadge({ state: 'absent', setupStatus: 'complete' });
    expect(badge).toMatchObject({ label: 'Paused', tone: 'idle', needsRepair: false });
  });

  it('asks for repair when the container is gone', () => {
    expect(projectBadge({ state: 'failed' })).toMatchObject({
      tone: 'danger',
      needsRepair: true,
    });
    expect(projectNeedsRepair({ state: 'failed' })).toBe(true);
    expect(projectNeedsRepair({ state: 'active' })).toBe(false);
  });

  // Blue is the session list's unread-message dot. Reusing it for a project state
  // would give the same color two meanings in the same dot gutter.
  it('never uses the session unread/active tone', () => {
    const states = ['absent', 'cloning', 'container_starting', 'active', 'failed'] as const;
    const tones = states.map((state) => projectBadge({ state }).tone);
    expect(tones).not.toContain('active');
    expect(UNAVAILABLE_PROJECT_BADGE.tone).not.toBe('active');
    expect(UNTRACKED_PROJECT_BADGE.tone).not.toBe('active');
  });

  it('does not offer repair without a live project row', () => {
    // Missing rows include soft-deleted projects, which POST /repair rejects.
    expect(UNAVAILABLE_PROJECT_BADGE).toMatchObject({ label: 'Unavailable', needsRepair: false });
    expect(UNTRACKED_PROJECT_BADGE.needsRepair).toBe(false);
  });
});
