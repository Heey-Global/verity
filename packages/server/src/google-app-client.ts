import type { FastifyRequest } from 'fastify';

/** App identity selects an allowlisted native OAuth client, never an arbitrary request ID. */
export function googleAppClient(
  request: FastifyRequest,
  production: string | undefined,
  staging: string | undefined,
): string | undefined {
  const variant = request.headers['x-verity-app-variant'];
  if (variant === undefined || variant === 'production') return production;
  if (variant === 'staging') return staging;
  return undefined;
}
