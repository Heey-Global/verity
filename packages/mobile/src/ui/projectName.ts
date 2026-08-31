import type { ProjectRecord } from '../api.js';

/**
 * How a project is named in operator-facing copy.
 *
 * A GitHub-backed project is named by its repository coordinate (`acme/web`) —
 * that string is the identity the operator recognises and can paste into GitHub.
 * A project created WITHOUT a GitHub repository has no such coordinate: its
 * `owner` is a reserved internal placeholder Verity needs to satisfy the
 * `(owner, repo)` uniqueness constraint. So a local project is named by its
 * `repo` slug alone.
 *
 * Pure TS (no React Native / theme) so the rule stays unit-testable and every
 * surface — overview, project detail, dialogs — resolves the name identically.
 * Use {@link projectRepoRef} instead wherever the string must be a real GitHub
 * coordinate (a URL, a `POST /sessions { project }` body).
 */
export function projectDisplayName(
  project: Pick<ProjectRecord, 'owner' | 'repo' | 'kind'>,
): string {
  return project.kind === 'local' ? project.repo : `${project.owner}/${project.repo}`;
}

/** The `owner/repo` coordinate, or `undefined` when the project has no GitHub
 *  repository behind it. Callers that build a github.com URL or an API argument
 *  must use this and handle `undefined`, never {@link projectDisplayName}. */
export function projectRepoRef(
  project: Pick<ProjectRecord, 'owner' | 'repo' | 'kind'>,
): string | undefined {
  return project.kind === 'local' ? undefined : `${project.owner}/${project.repo}`;
}
