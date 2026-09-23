const tails = new Map<string, Promise<void>>();

/** Serialize Server-side mutations of one Knowledge root. */
export async function acquireKnowledgeMutationLock(root: string): Promise<() => void> {
  const predecessor = tails.get(root) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = predecessor.then(() => current);
  tails.set(root, tail);
  await predecessor;
  return () => {
    releaseCurrent();
    if (tails.get(root) === tail) tails.delete(root);
  };
}
