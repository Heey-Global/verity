import type { EventStore, GitHubRepositoryObservation } from '@verity/store';

type CheckoutSync = { syncProjectCheckout(projectId: string): Promise<void> };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Record what GitHub reported about a repository and let every project that
 * followed it to a new name refresh its clone in the background: the clone keeps
 * its directory, and its `origin` moves to the new name, so a running sandbox
 * reaches the repository under the name its forge binding now carries.
 */
export async function reconcileGitHubRepository(
  eventStore: Pick<EventStore, 'githubRepositories' | 'getProject'>,
  provisioner: (() => CheckoutSync | undefined) | undefined,
  observation: GitHubRepositoryObservation,
): Promise<string[]> {
  const { renamedProjectIds } = await eventStore.githubRepositories.reconcile(observation);
  for (const projectId of renamedProjectIds) {
    console.warn(
      `verity: GitHub repository ${observation.requestedOwner}/${observation.requestedRepo} ` +
        `is now ${observation.owner}/${observation.repo}; project ${projectId} follows it`,
    );
    // `syncProjectCheckout` shares the per-project checkout lock with provisioning,
    // so a rename recorded mid-provision queues behind it instead of racing it.
    void (async () => {
      try {
        const project = await eventStore.getProject(projectId);
        // A project without a Sandbox has no clone yet; provisioning uses the new name.
        if (project === undefined || project.state === 'absent') return;
        await provisioner?.()?.syncProjectCheckout(projectId);
      } catch (error) {
        console.warn(
          `verity: project ${projectId} checkout did not follow the repository rename: ${message(error)}`,
        );
      }
    })();
  }
  return renamedProjectIds;
}
