type ProjectCollapseWrite = (projectId: string, collapsed: boolean) => Promise<unknown>;

type ProjectCollapseCallbacks = {
  success: () => void;
  failure: (error: unknown) => void;
};

/**
 * Persist fold changes in click order and only reconcile the latest intent.
 * Without both guarantees, a slow expand response can undo a later collapse.
 */
export function createProjectCollapseQueue(write: ProjectCollapseWrite) {
  const chains = new Map<string, Promise<void>>();
  const generations = new Map<string, number>();

  return (projectId: string, collapsed: boolean, callbacks: ProjectCollapseCallbacks): void => {
    const generation = (generations.get(projectId) ?? 0) + 1;
    generations.set(projectId, generation);

    const previous = chains.get(projectId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          await write(projectId, collapsed);
          if (generations.get(projectId) === generation) callbacks.success();
        } catch (error) {
          if (generations.get(projectId) === generation) callbacks.failure(error);
        }
      })
      .finally(() => {
        if (chains.get(projectId) === current) chains.delete(projectId);
      });
    chains.set(projectId, current);
  };
}
