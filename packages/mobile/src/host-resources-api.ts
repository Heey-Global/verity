import { z } from 'zod';

import type { TransportRequestInit } from './api.js';

// `GET /diagnostics/host`: CPU, memory and disk of the machine the server runs
// on. `VerityClient` carries the call as `hostResources`
// (docs/adr/0029-module-boundaries-and-file-size.md).

export const hostResourcesSchema = z.object({
  observedAt: z.string(),
  cpu: z.object({ percent: z.number().nullable(), cores: z.number().int().nonnegative() }),
  memory: z.object({ usedBytes: z.number(), totalBytes: z.number() }),
  disk: z.object({ usedBytes: z.number(), totalBytes: z.number() }).nullable(),
});
export type HostResources = z.infer<typeof hostResourcesSchema>;

type Request = (path: string, init: TransportRequestInit) => Promise<Response>;

/** The host-resources call, bound to the client's `request`. Administrators
 *  only: anyone else gets a 403, which the caller treats as "not shown". */
export function hostResourcesClient(request: Request) {
  return async (): Promise<HostResources> => {
    const res = await request('/diagnostics/host', { method: 'GET' });
    return hostResourcesSchema.parse(await res.json());
  };
}

/** A used share in whole percent, or null when the total is unknown. */
export function usedPercent(used: { usedBytes: number; totalBytes: number }): number | null {
  if (!(used.totalBytes > 0)) return null;
  return Math.min(100, Math.max(0, Math.round((used.usedBytes / used.totalBytes) * 100)));
}
