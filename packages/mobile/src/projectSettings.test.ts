import { describe, expect, it } from 'vitest';

import type { ProjectSettings } from './api.js';
import {
  configuredProjectSettingsCount,
  projectSettingsDraft,
  projectSettingsPatchFromDraft,
  sameProjectSettingsDraft,
  type ProjectSettingsDraft,
} from './projectSettings.js';

function makeSettings(overrides: Partial<ProjectSettings> = {}): ProjectSettings {
  return {
    projectId: 'p/1',
    dopplerProject: null,
    dopplerConfig: null,
    defaultBranch: 'main',
    defaultModel: 'claude-sonnet-4-6',
    memory: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const EMPTY_DRAFT: ProjectSettingsDraft = {
  defaultBranch: '',
  defaultModel: '',
  memory: '',
};

describe('projectSettingsDraft', () => {
  it('seeds round-trip fields from settings', () => {
    const draft = projectSettingsDraft(makeSettings());
    expect(draft.defaultBranch).toBe('main');
    expect(draft.defaultModel).toBe('claude-sonnet-4-6');
  });

  it('falls back to empty strings when settings are null', () => {
    expect(projectSettingsDraft(null)).toEqual(EMPTY_DRAFT);
  });

  it('maps null stored fields to empty strings', () => {
    const draft = projectSettingsDraft(makeSettings({ defaultBranch: null }));
    expect(draft.defaultBranch).toBe('');
  });
});

describe('projectSettingsPatchFromDraft', () => {
  it('always includes the round-trip fields, trimming blanks to null', () => {
    const patch = projectSettingsPatchFromDraft(EMPTY_DRAFT);
    expect(patch.defaultBranch).toBeNull();
    expect(patch.defaultModel).toBeNull();
  });

  it('trims and keeps non-empty round-trip fields', () => {
    const patch = projectSettingsPatchFromDraft({
      ...EMPTY_DRAFT,
      defaultBranch: '  develop  ',
      defaultModel: ' codex/default ',
    });
    expect(patch.defaultBranch).toBe('develop');
    expect(patch.defaultModel).toBe('codex/default');
  });
});

describe('sameProjectSettingsDraft', () => {
  it('is true for a freshly seeded draft (no pending change)', () => {
    const settings = makeSettings();
    expect(sameProjectSettingsDraft(settings, projectSettingsDraft(settings))).toBe(true);
  });

  it('is false once a round-trip field is edited', () => {
    const settings = makeSettings();
    const draft = { ...projectSettingsDraft(settings), defaultBranch: 'release' };
    expect(sameProjectSettingsDraft(settings, draft)).toBe(false);
  });

  it('compares null-vs-empty as equal (blank field matches a null stored value)', () => {
    const settings = makeSettings({ defaultBranch: null });
    const draft = projectSettingsDraft(settings);
    expect(sameProjectSettingsDraft(settings, draft)).toBe(true);
  });

  it('handles null settings (every blank field matches, empty box)', () => {
    expect(sameProjectSettingsDraft(null, EMPTY_DRAFT)).toBe(true);
  });
});

describe('configuredProjectSettingsCount', () => {
  it('counts the two editable config fields', () => {
    const settings = makeSettings();
    expect(configuredProjectSettingsCount(settings, projectSettingsDraft(settings))).toBe(2);
  });

  it('counts zero for empty settings and an empty draft', () => {
    expect(configuredProjectSettingsCount(null, EMPTY_DRAFT)).toBe(0);
  });

  it('does not count agent memory toward configured settings', () => {
    const settings = makeSettings({ memory: 'a note' });
    const draft = projectSettingsDraft(settings);
    expect(draft.memory).toBe('a note');
    expect(configuredProjectSettingsCount(settings, draft)).toBe(2);
  });
});

describe('project memory (ADR 0008) in the draft', () => {
  it('seeds memory from settings and clears to empty when null', () => {
    expect(projectSettingsDraft(makeSettings({ memory: 'remember this' })).memory).toBe(
      'remember this',
    );
    expect(projectSettingsDraft(makeSettings({ memory: null })).memory).toBe('');
  });

  it('round-trips memory through the patch, trimming blanks to null', () => {
    expect(projectSettingsPatchFromDraft({ ...EMPTY_DRAFT, memory: '  note  ' }).memory).toBe(
      'note',
    );
    expect(projectSettingsPatchFromDraft(EMPTY_DRAFT).memory).toBeNull();
  });

  it('marks the draft dirty when only memory changed', () => {
    const settings = makeSettings({ memory: 'old' });
    const draft = { ...projectSettingsDraft(settings), memory: 'new' };
    expect(sameProjectSettingsDraft(settings, draft)).toBe(false);
  });

  it('treats an unchanged memory field as no pending change', () => {
    const settings = makeSettings({ memory: 'same' });
    expect(sameProjectSettingsDraft(settings, projectSettingsDraft(settings))).toBe(true);
  });
});
