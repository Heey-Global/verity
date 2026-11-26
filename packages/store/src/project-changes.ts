/**
 * Announces that a project row may have changed, so live views can be told
 * (ADR 0033). Every store writer of a project's state, image or overview fields
 * announces after its write committed; a writer that changes the row inside a
 * caller-owned transaction announces once that transaction has committed.
 *
 * An announcement carries only the project id. Listeners read the project and
 * decide what changed, so announcing more often than necessary is harmless,
 * while a missing announcement leaves views stale until their next read.
 */
export class ProjectChangeFeed {
  private readonly listeners = new Set<(projectId: string) => void>();

  /** Listen for announcements; returns the function that stops listening. */
  observe(listener: (projectId: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  announce(projectId: string): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(projectId);
      } catch {
        // A listener's failure must not fail the write that announced.
      }
    }
  }
}
