import { reconcileProjectOrder } from './projectReorder';

/** Serialize drops and retain the last confirmed order across failed saves. */
export function createProjectOrderSaver({
  getOrder,
  save,
  refresh,
  onChange,
  onError,
}: {
  getOrder: () => readonly string[];
  save: (order: string[]) => Promise<unknown>;
  refresh: () => Promise<unknown>;
  onChange: (order: string[]) => void;
  onError: (error: unknown) => void;
}) {
  let tail = Promise.resolve();
  let pending = 0;
  let revision = 0;
  let confirmed: readonly string[] = [];
  return (order: readonly string[]): Promise<void> => {
    const live = getOrder();
    const ids = reconcileProjectOrder(order, live);
    if (ids.every((id, index) => id === live[index])) return tail;
    if (pending === 0) confirmed = live;
    pending += 1;
    const current = ++revision;
    onChange(ids);
    tail = tail.then(async () => {
      try {
        // A project can disappear while an earlier save is still in flight.
        const next = reconcileProjectOrder(ids, getOrder());
        await save(next);
        confirmed = next;
        await refresh();
      } catch (error) {
        if (current === revision) onChange(reconcileProjectOrder(confirmed, getOrder()));
        onError(error);
      } finally {
        pending -= 1;
      }
    });
    return tail;
  };
}
