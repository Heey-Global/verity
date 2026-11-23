export interface SessionLinkProject {
  kind?: string;
  state: string;
  hiddenAt: Date | null;
}

/**
 * Whether a project's sessions can be linked and messaged. A sleeping project
 * qualifies: a linked message is an ordinary turn, and turn preparation wakes the
 * Sandbox before running it — the same states the turn route admits.
 */
export function isSessionLinkProject(project: SessionLinkProject): boolean {
  return (
    project.hiddenAt === null &&
    (project.state === 'active' || project.state === 'sleeping' || project.state === 'waking')
  );
}
