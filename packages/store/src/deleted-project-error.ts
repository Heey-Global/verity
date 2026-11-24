/** Thrown when creating or moving a session into a project that has
 *  been soft-deleted (`hidden_at` set). Project deletion reaps the project's
 *  sessions, so a session inserted afterwards would outlive its project and
 *  reappear in the overview as an orphan. Callers map this to the same 404 an
 *  unknown project id gets — a hidden project is gone as far as spawning is
 *  concerned. */
export class DeletedProjectError extends Error {
  constructor(readonly projectId: string) {
    super(`project ${projectId} has been deleted`);
    this.name = 'DeletedProjectError';
  }
}
