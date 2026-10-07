import { type IntegrationSource } from '@verity/mobile';
import { projectMatrixRooms } from './projectMatrixRooms';

function room(
  sourceId: string,
  projectId: string | null,
  status: IntegrationSource['status'],
): IntegrationSource {
  return { sourceId, projectId, status } as IntegrationSource;
}

test('keeps existing paused bindings visible and never offers another project’s rooms', () => {
  const own = room('own', 'project-a', 'paused');
  const pending = room('invite', null, 'pending');
  const elsewhere = room('elsewhere', 'project-b', 'pending');
  const disconnected = room('old', null, 'paused');
  expect(projectMatrixRooms([own, pending, elsewhere, disconnected], 'project-a')).toEqual({
    connected: [own],
    invitations: [pending],
  });
});
