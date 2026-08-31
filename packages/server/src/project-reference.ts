import type { ProjectRecord } from '@verity/store';

/**
 * Resolve a project reference a control-plane tool was given: a Verity project id, a bare
 * repository name, or `owner/repo`, matched case-insensitively against the live project list.
 *
 * Shared rather than restated because the approval cards make a promise about it — the session
 * handoff's caveat says the name "must match exactly one project, or the call fails rather than
 * choosing". A second copy of this would leave that promise asserted against whichever copy the
 * test happened to reach, and true of the other only by coincidence.
 *
 * Ambiguity fails; it is never broken by preferring one match class over another. A bare repo
 * name shared by two projects is exactly the case where guessing would deliver a briefing to
 * the wrong fleet, and the caller can always name the id.
 *
 * `fail` builds the error so each tool keeps its own error type — the gateway route maps those
 * to different outcomes — while the sentence stays in one place.
 */
export function resolveProjectReference(
  projects: readonly ProjectRecord[],
  reference: string,
  fail: (message: string) => Error,
): ProjectRecord {
  const normalized = reference.toLowerCase();
  const matches = projects.filter(
    (project) =>
      project.id.toLowerCase() === normalized ||
      project.repo.toLowerCase() === normalized ||
      `${project.owner}/${project.repo}`.toLowerCase() === normalized,
  );
  if (matches.length !== 1)
    throw fail(`project reference ${reference} does not resolve to one Verity project`);
  return matches[0]!;
}
