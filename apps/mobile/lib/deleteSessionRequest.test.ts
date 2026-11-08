// Only a project has a Wiki. A session outside one must neither be offered
// the switch nor be sent as kept for a Wiki it cannot have.
import { deleteSessionRequest } from './deleteSessionRequest';

describe('deleteSessionRequest', () => {
  it('offers a project session for its Wiki, switched on', async () => {
    const onDelete = jest.fn();
    const request = deleteSessionRequest({ label: 'Fix', projectId: 'p' }, onDelete);
    expect(request.option).toMatchObject({ title: 'Use for the Wiki', initial: true });
    await request.onConfirm(false);
    expect(onDelete).toHaveBeenLastCalledWith({ wiki: false });
    await request.onConfirm(true);
    expect(onDelete).toHaveBeenLastCalledWith({ wiki: true });
  });

  it('asks nothing for a session outside a project and keeps nothing', async () => {
    const onDelete = jest.fn();
    const request = deleteSessionRequest({ label: 'Chat', projectId: null }, onDelete);
    expect(request.option).toBeUndefined();
    await request.onConfirm(true);
    expect(onDelete).toHaveBeenCalledWith({ wiki: false });
  });
});
