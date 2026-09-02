import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { EventStore, VeritySettingsRecord } from '@verity/store';
import { bearerToken } from './auth.js';
import {
  GitSignError,
  resolveSigningPrivateKey,
  signGitPayload,
  type SshSignSpawner,
} from './git-signer.js';
import { internalConnectionIdentity } from './internal-listener.js';
import type { SigningCapabilityRegistry } from './signing-capability.js';

interface GitSignRouteStore extends EventStore {
  getVeritySettings(): Promise<VeritySettingsRecord | undefined>;
}

function hasGitSignRouteStore(store: EventStore): store is GitSignRouteStore {
  return 'getVeritySettings' in store && typeof store.getVeritySettings === 'function';
}

function gitSignRouteStore(store: EventStore): GitSignRouteStore {
  if (!hasGitSignRouteStore(store)) {
    throw new Error('verity settings store methods are not available');
  }
  return store;
}

export interface GitSignRouteDeps {
  eventStore: EventStore;
  signingCapabilities?: SigningCapabilityRegistry | undefined;
  sshSign?: SshSignSpawner | undefined;
}

/** Registers the project-socket commit-signing broker. */
export function registerGitSignRoute(app: FastifyInstance, deps: GitSignRouteDeps): void {
  // ── Commit-signing broker (audit finding H1) ──────────────────────────────
  // `POST /internal/git/sign` — called by the sandbox's `gpg.ssh.program`
  // wrapper, NOT the operator, so it's in the pre-auth allowlist and authenticates
  // itself with the broker token (the SHA-256 of the fleet signing key, which the
  // provisioner injects into the container and this route re-derives). The private
  // key stays server-side in the sealed store — it never enters a sandbox — so a
  // compromised package can no longer exfiltrate it and forge verified commits
  // fleet-wide; the residual is a signing oracle usable only while the container
  // runs. Requires the cipher unsealed (to read the key) → a sealed store surfaces
  // as a clean 503 via the error boundary.
  const gitSignBody = z.object({
    // git uses `git` for both commit and tag signatures; signGitPayload refuses
    // anything else so the broker can't be turned into a generic signing oracle.
    namespace: z.string().min(1).max(64),
    // The commit/tag payload git handed the signing program, base64-encoded.
    payload: z.string().min(1).max(1_000_000),
  });
  if (deps.signingCapabilities !== undefined)
    app.post(
      '/internal/git/sign',
      async (request, reply): Promise<{ signature: string } | { error: string }> => {
        // Reject a token-less probe up front, BEFORE reading settings, so an
        // unauthenticated caller can't distinguish the server's state (sealed 503 /
        // no-key 409 / bad-token 401) by drive-by requests — all it ever sees is 401.
        const presented = bearerToken(request.headers.authorization) ?? '';
        if (presented === '') {
          reply.code(401);
          return { error: 'unauthorized' };
        }
        const socketIdentity = internalConnectionIdentity(request);
        const capabilityBinding =
          socketIdentity === undefined
            ? undefined
            : await deps.signingCapabilities?.resolve(presented);
        const capabilityAuthorized =
          socketIdentity !== undefined &&
          capabilityBinding?.projectId === socketIdentity.projectId &&
          capabilityBinding.containerGeneration === socketIdentity.containerGeneration;

        // A project socket accepts only its own generation-bound capability. Reject
        // before decrypting settings so an invalid UDS caller cannot distinguish a
        // sealed store from a missing signing key.
        if (socketIdentity !== undefined && !capabilityAuthorized) {
          reply.code(401);
          return { error: 'unauthorized' };
        }
        if (socketIdentity === undefined) {
          reply.code(401);
          return { error: 'unauthorized' };
        }

        // Decrypting read — throws SealedError (→ 503) while the store is sealed.
        const settings = await gitSignRouteStore(deps.eventStore).getVeritySettings();
        // DB contents OR the file at gitSshPrivateKeyPath — the SAME resolution the
        // provisioner uses to derive the sandbox token, so the two agree on the key.
        const privateKey = resolveSigningPrivateKey(settings);
        if (privateKey === null || privateKey.trim().length === 0) {
          reply.code(409);
          return { error: 'no signing key configured' };
        }
        if (!capabilityAuthorized) {
          reply.code(401);
          return { error: 'unauthorized' };
        }
        const { namespace, payload } = gitSignBody.parse(request.body);
        const buffer = Buffer.from(payload, 'base64');
        try {
          const signature = await signGitPayload(privateKey, buffer, namespace, deps.sshSign);
          // Audit trail (the cheap 80% win): what was signed, when — not the payload.
          request.log.info(
            {
              namespace,
              bytes: buffer.length,
              ...(socketIdentity !== undefined
                ? {
                    projectId: socketIdentity.projectId,
                    containerGeneration: socketIdentity.containerGeneration,
                  }
                : {}),
            },
            'verity: brokered a git commit signature',
          );
          return { signature };
        } catch (err) {
          if (err instanceof GitSignError) {
            reply.code(400);
            return { error: 'signing refused' };
          }
          throw err;
        }
      },
    );
}
