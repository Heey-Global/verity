import type { FastifyInstance } from 'fastify';
import type { EventStore } from '@verity/store';
import type { StorageReclamation } from './storage-reclamation.js';

/** The global paired-device/browser gate applies; host-wide mutation also requires administrator rights. */
export function registerStorageReclamationRoutes(
  app: FastifyInstance,
  store: EventStore,
  service?: StorageReclamation,
): void {
  const allowed = async (id: string | null) =>
    Boolean(id && (await store.isActiveAdministrator(id)));
  app.get('/settings/storage/reclamation', async (request, reply) => {
    if (!(await allowed(request.localUserId)))
      return reply.code(403).send({ error: 'Administrator access required' });
    if (!service) return reply.code(503).send({ error: 'Storage reclamation is unavailable' });
    return service.status();
  });
  app.post('/settings/storage/reclamation', async (request, reply) => {
    if (!(await allowed(request.localUserId)))
      return reply.code(403).send({ error: 'Administrator access required' });
    if (!service) return reply.code(503).send({ error: 'Storage reclamation is unavailable' });
    if (request.body !== undefined)
      return reply.code(400).send({ error: 'This action takes no parameters' });
    await service.start();
    return reply.code(202).send(await service.status());
  });
}
