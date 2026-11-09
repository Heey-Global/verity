import type { ProjectRecord } from '../api.js';

/**
 * How a project is named in operator-facing copy: by its own name, which the
 * person gives it and can change, independent of its repositories.
 *
 * A server that predates project names sends none; the project is then named
 * as it was before — a repository project by its `owner/repo` coordinate, a
 * local project by its `repo` slug (its `owner` is a reserved placeholder).
 *
 * Pure TS (no React Native / theme) so the rule stays unit-testable and every
 * surface — overview, project detail, dialogs — resolves the name identically.
 * Use {@link projectRepoRef} instead wherever the string must be a real GitHub
 * coordinate (a URL, a `POST /sessions { project }` body).
 */
export function projectDisplayName(
  project: Pick<ProjectRecord, 'owner' | 'repo' | 'kind'> & { name?: string | undefined },
): string {
  if (project.name !== undefined && project.name.trim() !== '') return project.name;
  return project.kind === 'local' ? project.repo : `${project.owner}/${project.repo}`;
}

/** The short name lists, headers and pickers show: the project's own name,
 *  or — from a server that predates names — its repository name, as these
 *  surfaces showed before. */
type Titled = { repo: string; name?: string | undefined };
export function projectTitle(project: Titled): string;
export function projectTitle(project: Titled | undefined): string | undefined;
export function projectTitle(project: Titled | undefined): string | undefined {
  if (project === undefined) return undefined;
  return project.name !== undefined && project.name.trim() !== '' ? project.name : project.repo;
}

/** The `owner/repo` coordinate, or `undefined` when the project has no GitHub
 *  repository behind it. Callers that build a github.com URL or an API argument
 *  must use this and handle `undefined`, never {@link projectDisplayName}. */
export function projectRepoRef(
  project: Pick<ProjectRecord, 'owner' | 'repo' | 'kind'>,
): string | undefined {
  return project.kind === 'local' ? undefined : `${project.owner}/${project.repo}`;
}
