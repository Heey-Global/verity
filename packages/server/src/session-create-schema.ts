import { z } from 'zod';
import { parseOwnerRepo } from './canonical.js';
import { turnCore } from './session-request-core.js';

// Body for POST /sessions: create a visible Verity session/worktree immediately.
// No backend turn starts here; the first LLM call happens when the operator sends
// the first message via POST /sessions/:id/turns. `prompt` is accepted only as
// client-side draft/branch context for legacy callers.
const spawnBody = z
  .object({
    prompt: z.string().optional(),
    ...turnCore,
    /**
     * The session id to create, minted by the CLIENT so the app can open the chat
     * before this request answers (creating a session costs a `git fetch` + a
     * `worktree add`, which the operator should not have to watch). Constrained to a
     * UUID — the same shape the server mints — so a client can never choose an id
     * that collides with another namespace or reads as anything but opaque.
     *
     * The route is idempotent on it: an id whose session already exists returns that
     * session untouched, and two concurrent requests for one id share a single
     * provisioning run. That is what makes a client retry safe — without it, the
     * natural retry on a slow spawn would strand a second worktree on disk.
     */
    sessionId: z.string().uuid().optional(),
    name: z.string().min(1).max(80).optional(),
    /** Spawn-from-issue (#137): the GitHub issue # this session is started from. Names
     * the worktree branch `feat/<issue>-…` so the header shows `Issue #N`. Cosmetic +
     * best-effort — an invalid value is rejected by the schema, never trusted into a
     * shell (the branch name is sanitized in `makeBranch`). */
    issue: z.number().int().positive().optional(),
    /**
     * Multi-repo fleet-registry target (concept §19.6, #174): the canonical
     * `<owner>/<repo>` of the project this session is created in. The server looks
     * up the `projects` row (the slice-2 `GET /projects` sync cached it), and:
     *   - if `state === 'active'` → creates the session bound to the project;
     *   - otherwise → fires the {@link ServerDeps.provisioner} async, returns
     *     `202 awaiting_provisioning`; the operator polls `GET /projects/:id` and
     *     re-sends `POST /sessions { project }` when the container is `active`.
     * The input is canonicalised through {@link parseOwnerRepo} (§19.0 — rejects
     * malformed/`..`/multi-segment forms with 400, never silently coerces).
     */
    project: z
      .string()
      .optional()
      .refine((s) => s === undefined || parseOwnerRepo(s) !== undefined, 'invalid project'),
    /** Stable fleet-registry identity. This also addresses local projects whose
     * reserved internal owner is intentionally not a valid GitHub owner. */
    projectId: z.string().min(1).optional(),
    confirmProvisionWarnings: z.boolean().optional(),
  })
  .refine((body) => body.project === undefined || body.projectId === undefined, {
    message: 'provide project or projectId, not both',
  });

export type SpawnBody = z.infer<typeof spawnBody>;

function normalizeSpawnRequestBody(body: unknown): unknown {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'string') return body;
  const trimmed = body.trim();
  if (trimmed.length === 0) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return body;
  }
}

export function parseSpawnRequestBody(body: unknown): SpawnBody {
  return spawnBody.parse(normalizeSpawnRequestBody(body));
}
