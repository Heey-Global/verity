import { createHash, randomBytes } from 'node:crypto';

import type { Database } from '@verity/store';
import type { Kysely } from 'kysely';

/**
 * Server-side GitHub-token broker (security review, Doppler-pattern per-project
 * scoping + signing-broker transport). Instead of materializing a short-lived
 * GitHub installation token into a file inside every sandbox, the sandbox holds
 * only an opaque per-container CAPABILITY and redeems it on demand at
 * `POST /internal/github/token`. The server maps the capability to a fixed,
 * server-side binding (the project's owner/repo) and mints a repo-scoped token
 * from it — so the sandbox never names the repo or the scope, and a leaked
 * capability only ever yields tokens for its own project (and only from inside
 * the internal network the `/internal/*` origin guard enforces).
 *
 * The capability is NOT a GitHub credential: it is redeemable only against this
 * broker, and the actual token is minted fresh per request and never persisted.
 * The binding lives server-side keyed by the SHA-256 of the capability — the raw
 * secret is never stored, so a DB dump cannot recover a usable capability.
 *
 * PERSISTED in Postgres (not in-memory): a sandbox keeps its capability for the
 * life of the container, which outlives server restarts/redeploys. An in-memory
 * registry lost every binding on restart, so after any redeploy an existing
 * sandbox's `git push` failed with HTTP 401 ("could not read Username"). The
 * table survives, so capabilities keep working across redeploys.
 */

/** The server-side entitlement a capability maps to. `owner`/`repo` are what the
 *  token is minted for; the sandbox cannot influence them. */
interface GhTokenCapabilityBinding {
  projectId: string;
  owner: string;
  repo: string;
  /** Required for project-bound Unix-socket redemption. Omitted only for legacy
   *  TCP capabilities, which a project socket rejects. */
  containerGeneration?: string | undefined;
}

export interface GhTokenCapabilityRegistry {
  /**
   * Issue a fresh capability bound to a project, replacing any previous one for
   * the same project (so a re-provision rotates it and invalidates the old one).
   * Returns the raw opaque secret to inject into the sandbox — only its hash is
   * stored.
   */
  issue(binding: GhTokenCapabilityBinding): Promise<string>;
  /** Resolve a presented capability to its binding, or `undefined` if unknown. */
  resolve(capability: string): Promise<GhTokenCapabilityBinding | undefined>;
  /** Drop a project's capability (deprovision). No-op when none is registered. */
  revokeProject(projectId: string): Promise<void>;
}

/** Number of random bytes in a capability secret. 32 bytes = 256 bits of entropy,
 *  so the capability is not guessable and a hash lookup needs no constant-time
 *  compare (an attacker cannot get close enough to a valid value to time it). */
const CAPABILITY_BYTES = 32;

function hashCapability(capability: string): string {
  return createHash('sha256').update(`verity-gh-token-cap:${capability}`).digest('hex');
}

/**
 * Build a Postgres-backed capability registry. The raw capability is never held
 * or stored — only its SHA-256 hash → binding. Survives server restarts, so a
 * redeploy no longer invalidates the capabilities already handed to sandboxes.
 */
export function createGhTokenCapabilityRegistry(db: Kysely<Database>): GhTokenCapabilityRegistry {
  return {
    async issue(binding): Promise<string> {
      const capability = randomBytes(CAPABILITY_BYTES).toString('base64url');
      const capHash = hashCapability(capability);
      // UPSERT on the project_id PK: a re-issue overwrites the row, so the
      // superseded capability's hash is gone and the old capability stops
      // resolving — exactly the previous in-memory rotate/revoke semantics.
      await db
        .insertInto('gh_token_capabilities')
        .values({
          project_id: binding.projectId,
          cap_hash: capHash,
          owner: binding.owner,
          repo: binding.repo,
          container_generation: binding.containerGeneration ?? null,
        })
        .onConflict((oc) =>
          oc.column('project_id').doUpdateSet({
            cap_hash: capHash,
            owner: binding.owner,
            repo: binding.repo,
            container_generation: binding.containerGeneration ?? null,
          }),
        )
        .execute();
      return capability;
    },
    async resolve(capability): Promise<GhTokenCapabilityBinding | undefined> {
      if (capability.length === 0) return undefined;
      const row = await db
        .selectFrom('gh_token_capabilities')
        .select(['project_id', 'owner', 'repo', 'container_generation'])
        .where('cap_hash', '=', hashCapability(capability))
        .executeTakeFirst();
      if (row === undefined) return undefined;
      return {
        projectId: row.project_id,
        owner: row.owner,
        repo: row.repo,
        ...(row.container_generation !== null
          ? { containerGeneration: row.container_generation }
          : {}),
      };
    },
    async revokeProject(projectId): Promise<void> {
      await db.deleteFrom('gh_token_capabilities').where('project_id', '=', projectId).execute();
    },
  };
}
