import { createProjectCollapseQueue } from './projectCollapseQueue';

describe('project collapse persistence', () => {
  it('keeps a later collapse from being undone by an earlier expand response', async () => {
    const flushPromises = () => new Promise<void>((resolve) => setImmediate(resolve));
    let finishExpand: ((value: { collapsed: boolean }) => void) | undefined;
    const write = jest
      .fn<Promise<{ collapsed: boolean }>, [string, boolean]>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishExpand = resolve;
          }),
      )
      .mockResolvedValueOnce({ collapsed: true });
    const reconcile = jest.fn();
    const fail = jest.fn();
    const enqueue = createProjectCollapseQueue(write);

    enqueue('project-1', false, { success: reconcile, failure: fail });
    await flushPromises();
    enqueue('project-1', true, { success: reconcile, failure: fail });

    expect(write).toHaveBeenCalledTimes(1);
    finishExpand?.({ collapsed: false });
    await flushPromises();
    expect(write).toHaveBeenNthCalledWith(2, 'project-1', true);
    await flushPromises();

    expect(reconcile).toHaveBeenCalledWith(true);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(fail).not.toHaveBeenCalled();
  });
});
