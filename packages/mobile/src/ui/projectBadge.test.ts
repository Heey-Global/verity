import { describe, expect, it } from 'vitest';
import { PROJECT_IMAGE_REBUILDING_WARNING } from '@verity/events';

import {
  UNAVAILABLE_PROJECT_BADGE,
  UNTRACKED_PROJECT_BADGE,
  projectBadge,
  projectNeedsRepair,
} from './projectBadge.js';

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

  it('reports an active project with an image rebuild as working', () => {
    expect(
      projectBadge({
        state: 'active',
        provisionWarning: PROJECT_IMAGE_REBUILDING_WARNING,
      }),
    ).toEqual({
      label: 'Rebuilding…',
      tone: 'working',
      pulsing: true,
      needsRepair: false,
    });
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
