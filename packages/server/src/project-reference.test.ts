import type { ProjectRecord } from '@verity/store';
import { describe, expect, it } from 'vitest';
import { resolveProjectReference } from './project-reference.js';

function project(overrides: Partial<ProjectRecord> & Pick<ProjectRecord, 'id'>): ProjectRecord {
  return {
    owner: 'acme',
    repo: overrides.id,
    containerName: `verity-${overrides.id}`,
    kind: 'github',
    imageRef: null,
    state: 'active',
    provisionError: null,
    provisionWarning: null,
    hiddenAt: null,
    latestReleaseTag: null,
    latestReleaseName: null,
    latestReleasePublishedAt: null,
    latestReleaseUrl: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    stateChangedAt: new Date(0),
    ...overrides,
  };
}

/** Distinguishable from anything the resolver might throw on its own. */
class ToolError extends Error {}
const fail = (message: string): Error => new ToolError(message);

describe('resolveProjectReference', () => {
  const PROJECTS = [
    project({ id: 'web', owner: 'acme' }),
    project({ id: 'k8s', owner: 'acme' }),
    project({ id: 'infra', owner: 'other', repo: 'web' }),
  ];

  it('resolves by id, by bare repo name and by owner/repo', () => {
    expect(resolveProjectReference(PROJECTS, 'k8s', fail).id).toBe('k8s');
    expect(resolveProjectReference(PROJECTS, 'acme/web', fail).id).toBe('web');
    expect(resolveProjectReference(PROJECTS, 'other/web', fail).id).toBe('infra');
  });

  it('matches case-insensitively in every form', () => {
    expect(resolveProjectReference(PROJECTS, 'K8S', fail).id).toBe('k8s');
    expect(resolveProjectReference(PROJECTS, 'ACME/Web', fail).id).toBe('web');
  });

  it('fails on an ambiguous bare repo name rather than choosing one', () => {
    // `web` is the repo of both `web` and `infra`. This is the case the handoff card's caveat
    // promises about — "must match exactly one project, or the call fails rather than
    // choosing" — and delivering a briefing to whichever came first in the list is exactly
    // the wrong fleet it exists to prevent.
    expect(() => resolveProjectReference(PROJECTS, 'web', fail)).toThrow(ToolError);
    expect(() => resolveProjectReference(PROJECTS, 'web', fail)).toThrow(
      'project reference web does not resolve to one Verity project',
    );
    // Naming either one exactly is still allowed: ambiguity is a property of the reference,
    // not of the projects, so the caller is never locked out of a project it can name.
    expect(resolveProjectReference(PROJECTS, 'infra', fail).id).toBe('infra');
  });

  it('fails on no match, with the reference echoed back', () => {
    expect(() => resolveProjectReference(PROJECTS, 'nope', fail)).toThrow(
      'project reference nope does not resolve to one Verity project',
    );
  });

  it('throws whatever `fail` builds, so each tool keeps its own error type', () => {
    class OtherError extends Error {}
    expect(() =>
      resolveProjectReference(PROJECTS, 'nope', (message) => new OtherError(message)),
    ).toThrow(OtherError);
  });

  it('does not prefer an id match over an equally valid repo match', () => {
    // One project's id is another's repo name. Neither match class outranks the other, so
    // this is ambiguous rather than silently resolved to the id — the guarantee that keeps
    // the resolver's outcome independent of which field happened to match.
    const shadowed = [project({ id: 'web' }), project({ id: 'other', repo: 'web' })];
    expect(() => resolveProjectReference(shadowed, 'web', fail)).toThrow(ToolError);
  });

  it('resolves against an empty project list by failing, not by throwing on its own', () => {
    expect(() => resolveProjectReference([], 'web', fail)).toThrow(ToolError);
  });
});
