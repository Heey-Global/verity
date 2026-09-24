import {
  PROJECT_IMAGE_REBUILDING_WARNING,
  projectBadge,
  projectLifecycleBadge,
  type DevServerDetection,
  type ProjectRecord,
} from '@verity/mobile';

import {
  hasActionableToolkitDrift,
  hasPendingProjectSetup,
  hasUnreviewedDevServers,
  projectOverviewStatus,
  projectOverviewWarning,
  projectSetupStatus,
  toolkitDriftNotice,
} from './projectSetup';

const project = { state: 'cloning' } as ProjectRecord;
const detection = {
  fingerprint: 'new',
  reviewedFingerprint: null,
  detectedAt: '2026-01-01T00:00:00.000Z',
  reviewedAt: null,
  suggestions: [{ status: 'new' }],
} as DevServerDetection;

describe('project setup presentation', () => {
  it('maps internal lifecycle states to friendly progress', () => {
    expect(projectSetupStatus(project)).toMatchObject({
      label: 'Preparing repository…',
      step: 1,
      total: 5,
      intent: 'progress',
    });
    expect(projectSetupStatus({ ...project, state: 'container_starting' })).toMatchObject({
      label: 'Starting secure workspace…',
      step: 2,
    });
  });

  it('reports detected Dev Servers without exposing internal state names', () => {
    expect(projectSetupStatus({ ...project, state: 'active' }, detection).label).toBe(
      '1 Dev Server found',
    );
    expect(projectSetupStatus({ ...project, state: 'active' }).step).toBe(3);
    expect(projectSetupStatus({ ...project, state: 'active' }).total).toBe(5);
    expect(hasUnreviewedDevServers(detection)).toBe(true);
  });

  it.each([
    ['sleeping_starting', 'Pausing secure workspace…', 'progress'],
    ['sleeping', 'Sleeping', 'ready'],
    ['waking', 'Waking secure workspace…', 'progress'],
  ] as const)('presents %s as %s', (lifecycleState, label, intent) => {
    const sleepingProject = {
      ...project,
      state: 'active',
      lifecycleState,
      setupStatus: 'complete',
    } as ProjectRecord;

    expect(projectSetupStatus(sleepingProject)).toMatchObject({ label, intent });
    expect(projectOverviewStatus(sleepingProject)?.label).toBe(
      lifecycleState === 'sleeping' ? undefined : label,
    );
  });

  // The wizard, the detail screen and the overview row all describe the same
  // container. They used to each own a copy of the wording and drifted — a waking
  // project said "Waking…" beside its dot and "Waking secure workspace…" on its
  // row — so the step labels are now read out of the badge, not restated here.
  it('reads its step labels out of the badge rather than restating them', () => {
    for (const lifecycleState of [
      'cloning',
      'container_starting',
      'sleeping_starting',
      'sleeping',
      'waking',
    ] as const) {
      const record = { ...project, state: 'active', lifecycleState } as ProjectRecord;
      expect(projectSetupStatus(record).label).toBe(projectLifecycleBadge(record).label);
    }
    expect(projectSetupStatus({ ...project, state: 'absent' } as ProjectRecord).label).toBe(
      'Paused',
    );
  });

  // …out of the LIFECYCLE badge. The step numbers come from the lifecycle state
  // too, and background work does not advance them: a rebuild in flight over a
  // cloning project must not relabel step 1 of 5 as something that is not step 1.
  it('keeps its step and its label describing the same thing', () => {
    const cloningDuringRebuild = {
      ...project,
      provisionWarning: PROJECT_IMAGE_REBUILDING_WARNING,
      sandboxUpdate: { state: 'available', selfRepair: 'converging' },
    } as ProjectRecord;

    expect(projectSetupStatus(cloningDuringRebuild)).toMatchObject({
      label: 'Preparing repository…',
      step: 1,
    });
    // The row outside the wizard has no step to contradict, so there the rebuild
    // is the more useful answer — and that difference is the point of the split.
    expect(projectOverviewStatus(cloningDuringRebuild)?.label).toBe('Rebuilding secure workspace…');
  });

  it('does not treat optional setup as lifecycle progress', () => {
    const pending = { ...project, state: 'active', setupStatus: 'pending' } as ProjectRecord;

    expect(projectOverviewStatus(pending)).toBeUndefined();
    expect(projectOverviewStatus(pending, detection)?.label).toBe('1 Dev Server found');
    expect(hasPendingProjectSetup([pending])).toBe(false);
    expect(hasPendingProjectSetup([{ ...project, setupStatus: undefined }])).toBe(true);
    expect(hasPendingProjectSetup([{ ...pending, setupStatus: 'complete' }])).toBe(false);
    expect(hasPendingProjectSetup([{ ...pending, state: 'failed' }])).toBe(false);
  });

  // A broken sandbox has to say what broke: the reconciler's reason names the actual
  // failure, where the generic setup step read like just another progress line.
  it('shows the failure reason on a failed project', () => {
    const failed = {
      ...project,
      state: 'failed',
      setupStatus: 'complete',
      provisionError: 'Sandbox container stopped — Repair to restart it.',
    } as ProjectRecord;

    expect(projectOverviewStatus(failed)).toEqual({
      label: 'Sandbox container stopped — Repair to restart it.',
      tone: 'danger',
    });
    // Still explains itself when the server sent no reason, and while setup is
    // pending (where the label would otherwise fall through to a progress step).
    expect(projectOverviewStatus({ ...failed, provisionError: null })?.label).toBe(
      'Project setup needs attention',
    );
    expect(projectOverviewStatus({ ...failed, setupStatus: 'pending' })?.label).toBe(
      'Sandbox container stopped — Repair to restart it.',
    );
  });

  it('hides completed setup when no Dev Server changes need review', () => {
    const complete = { ...project, state: 'active', setupStatus: 'complete' } as ProjectRecord;
    const reviewed = { ...detection, reviewedFingerprint: detection.fingerprint };

    expect(projectOverviewStatus(complete, reviewed)).toBeUndefined();
  });
});

// The row has ONE line for this, and everything below used to be able to claim it
// at the same time — a setup step, an attention line and a self-repairing sandbox
// update with a spinner of its own, all beside a release tag.
describe('the project row status line', () => {
  const active = { ...project, state: 'active', setupStatus: 'complete' } as ProjectRecord;
  const converging = { state: 'available', selfRepair: 'converging' };

  // The reported bug: a green "Running" dot, a grey spinner and "Waiting to
  // update sandbox…" all on a row that was, in fact, working.
  it('reports a self-repairing sandbox update as work in progress', () => {
    expect(
      projectOverviewStatus({ ...active, sandboxUpdate: converging } as ProjectRecord),
    ).toEqual({ label: 'Updating secure workspace…', tone: 'working' });
  });

  // Whatever the pulsing dot means is what the line next to it has to say.
  // Anything else is the row reporting two states of one container.
  it('agrees with its own dot whenever Verity is working on the container', () => {
    for (const record of [
      { ...project, state: 'cloning' },
      { ...active, lifecycleState: 'waking' },
      { ...active, lifecycleState: 'sleeping_starting' },
      { ...active, sandboxUpdate: converging },
      { ...project, state: 'absent', setupStatus: 'pending' },
    ] as ProjectRecord[]) {
      const badge = projectBadge(record);
      expect(badge.pulsing).toBe(true);
      expect(projectOverviewStatus(record)).toEqual({ label: badge.label, tone: 'working' });
    }
  });

  // A finding that was already there a second ago is not more urgent than the
  // transition in flight, and it is still there when the transition ends. Two
  // texts in this slot is how a status message and a version tag collided.
  it('lets the transition in flight speak alone', () => {
    const drifted = {
      ...active,
      lifecycleState: 'waking',
      provisionWarning: 'remoteUser=root',
      toolkitDrift: { verdict: 'drifted', carrier: 'devcontainer' },
      sandboxUpdate: converging,
    } as ProjectRecord;

    expect(projectOverviewStatus(drifted)).toEqual({
      label: 'Waking secure workspace…',
      tone: 'working',
    });
  });

  // One rebuild wording, from the badge, not a second differently-phrased one
  // ("Rebuilding image…") in the attention slot beside it.
  it('reports a running image rebuild once', () => {
    const rebuilding = {
      ...active,
      provisionWarning: 'Project image rebuild is in progress.',
    } as ProjectRecord;

    expect(projectOverviewStatus(rebuilding)).toEqual({
      label: 'Rebuilding secure workspace…',
      tone: 'working',
    });
    expect(projectOverviewWarning(rebuilding)).toBeUndefined();
  });

  // The one thing that outranks work in progress. `state: 'failed'` does not clear
  // the warning that was true a moment earlier, so a container that died mid-rebuild
  // arrives here carrying both — and reporting the rebuild would hide, behind a
  // reassuring magenta line, the only row on the screen with something to press.
  it('gives a dead container the line even while a rebuild warning is attached', () => {
    const diedMidRebuild = {
      ...active,
      state: 'failed',
      provisionWarning: PROJECT_IMAGE_REBUILDING_WARNING,
      provisionError: 'Sandbox container stopped — Repair to restart it.',
      sandboxUpdate: converging,
    } as ProjectRecord;

    expect(projectOverviewStatus(diedMidRebuild)).toEqual({
      label: 'Sandbox container stopped — Repair to restart it.',
      tone: 'danger',
    });
    // And the dot agrees, rather than pulsing magenta over a danger-red line.
    expect(projectBadge(diedMidRebuild)).toMatchObject({ pulsing: false, needsRepair: true });
  });

  it('gives the slot to an attention line only once nothing is happening', () => {
    expect(
      projectOverviewStatus({ ...active, provisionWarning: 'remoteUser=root' } as ProjectRecord),
    ).toEqual({ label: 'remoteUser=root', tone: 'attention' });
  });

  // Nothing to report is a result: the row is then free to spend the line on the
  // project's own metadata (its release tag), which is what the caller renders
  // when this returns nothing.
  it('says nothing about a settled, healthy project', () => {
    expect(projectOverviewStatus(active)).toBeUndefined();
    // The grey moon in the dot gutter already says "sleeping".
    expect(
      projectOverviewStatus({ ...active, lifecycleState: 'sleeping' } as ProjectRecord),
    ).toBeUndefined();
  });

  it('still names a deliberately paused project, which has no symbol of its own', () => {
    expect(projectOverviewStatus({ ...active, state: 'absent' } as ProjectRecord)).toEqual({
      label: 'Paused',
      tone: 'idle',
    });
  });
});

describe('environment warnings on the overview', () => {
  const active = { ...project, state: 'active', setupStatus: 'complete' } as ProjectRecord;
  const drifted = (carrier: 'devcontainer' | 'base-image') =>
    ({ ...active, toolkitDrift: { verdict: 'drifted', carrier } }) as ProjectRecord;

  it('says nothing about a healthy project', () => {
    expect(projectOverviewWarning(active)).toBeUndefined();
    expect(
      projectOverviewWarning({
        ...active,
        toolkitDrift: { verdict: 'matches', carrier: 'devcontainer' },
      } as ProjectRecord),
    ).toBeUndefined();
  });

  it('surfaces a provision warning on a running project', () => {
    expect(
      projectOverviewWarning({
        ...active,
        provisionWarning: 'Runner supervisor is disabled after boundary attestation failed.',
      } as ProjectRecord),
    ).toBe('Runner supervisor is disabled after boundary attestation failed.');
  });

  // A rebuild in progress is work, not a finding, and `projectBadge` already
  // reports it with the same magenta pulse and wording as every other transition
  // — so this must NOT add a second, differently-phrased rebuild line beside it.
  it('leaves a running image rebuild to the badge', () => {
    expect(
      projectOverviewWarning({
        ...active,
        provisionWarning: 'Project image rebuild is in progress.',
      } as ProjectRecord),
    ).toBeUndefined();
  });

  // The chip is a call to action, so it narrows to the population a repair
  // actually fixes. A base-image project needs a new base image, and an unknown
  // verdict has no terminating advice at all — both would be noise on a row.
  it('chips only drift a repair can fix', () => {
    expect(hasActionableToolkitDrift(drifted('devcontainer'))).toBe(true);
    expect(projectOverviewWarning(drifted('devcontainer'))).toBe(
      'Sandbox toolkit needs re-checking',
    );

    expect(hasActionableToolkitDrift(drifted('base-image'))).toBe(false);
    expect(projectOverviewWarning(drifted('base-image'))).toBeUndefined();
    expect(
      projectOverviewWarning({
        ...active,
        toolkitDrift: { verdict: 'unknown', carrier: 'devcontainer' },
      } as ProjectRecord),
    ).toBeUndefined();
  });

  // Fleet-wide drift is the normal state right after a deploy. A specific
  // finding about this project's own provisioning run outranks it.
  it('prefers a provision warning over the drift verdict', () => {
    expect(
      projectOverviewWarning({
        ...drifted('devcontainer'),
        provisionWarning: 'remoteUser=root',
      } as ProjectRecord),
    ).toBe('remoteUser=root');
  });

  // A failed project already spends its one line on `provisionError`.
  it('stays quiet on a failed project', () => {
    expect(
      projectOverviewWarning({
        ...drifted('devcontainer'),
        state: 'failed',
        provisionWarning: 'remoteUser=root',
      } as ProjectRecord),
    ).toBeUndefined();
  });
});

describe('toolkit drift notice', () => {
  const active = { ...project, state: 'active' } as ProjectRecord;
  const notice = (verdict: string, carrier: string) =>
    toolkitDriftNotice({ ...active, toolkitDrift: { verdict, carrier } } as ProjectRecord);

  it('says nothing when there is no verdict or the verdict matches', () => {
    expect(toolkitDriftNotice(active)).toBeUndefined();
    expect(toolkitDriftNotice({ ...active, toolkitDrift: null } as ProjectRecord)).toBeUndefined();
    expect(notice('matches', 'devcontainer')).toBeUndefined();
  });

  // The whole reason the report keeps the populations apart: re-provisioning
  // rebuilds a devcontainer image, but only re-attests a base image.
  it('names the remedy each carrier actually has', () => {
    expect(notice('drifted', 'devcontainer')).toContain('rebuilds and re-attests');
    expect(notice('drifted', 'devcontainer')).not.toContain('base image fixes it');

    expect(notice('drifted', 'base-image')).toContain('cannot change what the image contains');
    expect(notice('drifted', 'base-image')).toContain('only a rebuilt base image fixes it');
  });

  // `unknown` has no remedy, so an older server still sending it must not
  // raise a banner nothing can clear.
  it('says nothing for an unknown verdict', () => {
    expect(notice('unknown', 'devcontainer')).toBeUndefined();
    expect(notice('unknown', 'base-image')).toBeUndefined();
  });

  // Identities are content hashes with no ordering, and the identity covers the
  // boundary policy too — so a mismatch is stale, not refuted.
  it('never claims the image is older or that it will fail', () => {
    for (const carrier of ['devcontainer', 'base-image']) {
      const text = notice('drifted', carrier) ?? '';
      expect(text).toMatch(/needs re-checking/);
      expect(text).not.toMatch(/older|out of date|will fail/i);
    }
  });
});
