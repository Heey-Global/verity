import type { FastifyInstance } from 'fastify';
import { bearerToken } from './auth.js';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import { internalConnectionIdentity } from './internal-listener.js';

export interface GitHubTokenRouteDeps {
  capabilities?: GhTokenCapabilityRegistry | undefined;
  mint?: ((project: { owner: string; repo: string }) => Promise<string | undefined>) | undefined;
}

/** Registers the project-socket GitHub token broker when both seams are available. */
export function registerGitHubTokenRoute(app: FastifyInstance, deps: GitHubTokenRouteDeps): void {
  // ── GitHub-token broker (security review) ─────────────────────────────────
  // `POST /internal/github/token` — called by the sandbox's git credential helper
  // / gh wrapper, NOT the operator, so it's in the pre-auth allowlist and
  // authenticates with a per-container CAPABILITY (not a GitHub credential). The
  // server resolves the capability to its server-side project binding and mints a
  // repo-scoped token FROM that binding — the sandbox never names the repo or the
  // scope, so a compromised container can only obtain tokens for its own project,
  // and only from inside the internal network the origin guard enforces. The token
  // is minted fresh per request and never persisted (no gh-token file at rest).
  if (deps.capabilities !== undefined && deps.mint !== undefined) {
    const ghTokenCapabilities = deps.capabilities;
    const ghTokenMint = deps.mint;
    app.post(
      '/internal/github/token',
      async (request, reply): Promise<{ token: string } | { error: string }> => {
        // A capability-less probe learns nothing about server state: always 401.
        const presented = bearerToken(request.headers.authorization) ?? '';
        const binding = presented === '' ? undefined : await ghTokenCapabilities.resolve(presented);
        const socketIdentity = internalConnectionIdentity(request);
        if (
          binding === undefined ||
          socketIdentity === undefined ||
          socketIdentity.projectId !== binding.projectId ||
          socketIdentity.containerGeneration !== binding.containerGeneration
        ) {
          reply.code(401);
          return { error: 'unauthorized' };
        }
        // Scope is the SERVER-SIDE binding, never a request field. The sandbox
        // cannot broaden it or point at another repo.
        const token = await ghTokenMint({ owner: binding.owner, repo: binding.repo });
        if (token === undefined || token.length === 0) {
          reply.code(502);
          return { error: 'could not mint a token' };
        }
        // Audit trail: which project asked, when — never the token itself.
        request.log.info(
          { projectId: binding.projectId, repo: `${binding.owner}/${binding.repo}` },
          'verity: brokered a GitHub token',
        );
        return { token };
      },
    );
  }
}
