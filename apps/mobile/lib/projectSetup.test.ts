import type { DevServerDetection, ProjectRecord } from '@verity/mobile';

import {
  hasActionableToolkitDrift,
  hasPendingProjectSetup,
  hasUnreviewedDevServers,
  projectOverviewSetupLabel,
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

  it('keeps pending setup live on the overview until setup is completed', () => {
    const pending = { ...project, state: 'active', setupStatus: 'pending' } as ProjectRecord;

    expect(projectOverviewSetupLabel(pending)).toBe('Detecting Dev Server…');
    expect(projectOverviewSetupLabel(pending, detection)).toBe('1 Dev Server found');
    expect(hasPendingProjectSetup([pending])).toBe(true);
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

    expect(projectOverviewSetupLabel(failed)).toBe(
      'Sandbox container stopped — Repair to restart it.',
    );
    // Still explains itself when the server sent no reason, and while setup is
    // pending (where the label would otherwise fall through to a progress step).
    expect(projectOverviewSetupLabel({ ...failed, provisionError: null })).toBe(
      'Project setup needs attention',
    );
    expect(projectOverviewSetupLabel({ ...failed, setupStatus: 'pending' })).toBe(
      'Sandbox container stopped — Repair to restart it.',
    );
  });

  it('hides completed setup when no Dev Server changes need review', () => {
    const complete = { ...project, state: 'active', setupStatus: 'complete' } as ProjectRecord;
    const reviewed = { ...detection, reviewedFingerprint: detection.fingerprint };

    expect(projectOverviewSetupLabel(complete, reviewed)).toBeUndefined();
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

  it('uses a compact overview label while an image rebuild is running', () => {
    expect(
      projectOverviewWarning({
        ...active,
        provisionWarning: 'Project image rebuild is in progress.',
      } as ProjectRecord),
    ).toBe('Rebuilding image…');
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

  // Must not read as an all-clear, and must not promise a repair it cannot keep.
  it('reports an unrecorded verdict as unruled-out, not as clean', () => {
    const unknown = notice('unknown', 'devcontainer');
    expect(unknown).toContain('cannot be ruled out');
    expect(unknown).not.toContain('Repairing');
  });

  // `unknown` has three causes — never compared, comparison failed, or this
  // server could not read its own toolkit to compare against — and the wire
  // carries no way to tell them apart. Naming one would be wrong for the others.
  it('does not attribute an unknown verdict to a cause it cannot know', () => {
    const unknown = notice('unknown', 'devcontainer') ?? '';
    // "has not been compared" holds in all three cases. Naming which one does not.
    expect(unknown).toContain('has not been compared');
    expect(unknown).not.toMatch(/never compared|failed that comparison|could not read/i);
  });

  // A server that cannot read its own bundle reports `unknown` for every
  // project, including ones whose recorded identity is intact. Saying "nothing
  // is recorded for this environment" would blame those projects for a fault
  // one level up.
  it('makes no claim about what this project has on record', () => {
    const unknown = notice('unknown', 'devcontainer') ?? '';
    expect(unknown).not.toMatch(/recorded|no verified/i);
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
