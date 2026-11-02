// Keep global request types available without loading the server's runtime graph.
import type {} from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set only after the paired-device bearer has been verified. */
    localUserId: string | null;
  }
}
