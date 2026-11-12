import type { FastifyInstance } from 'fastify';
import { isGitAuthor } from '@verity/session';
import { SealedError, type EventStore, type SealableSecretCipher } from '@verity/store';
import { z } from 'zod';
import './fastify-augmentation.js';
import { generateSigningKey, type SshKeygenSpawner } from './signing-key.js';
import { viewerId } from './view-state-routes.js';

type GitIdentityStore = Pick<EventStore, 'userGitIdentities' | 'userGithubAuthorizations'>;

const identityPatch = z
  .object({
    authorName: z.string().trim().max(200).nullable().optional(),
    authorEmail: z.string().trim().max(320).nullable().optional(),
  })
  .strict();

/** GitHub's noreply address for an account: attributed to it without publishing a
 *  private address, and the principal GitHub verifies a registered key against. */
function noreplyEmail(account: { githubUserId: string; login: string }): string {
  return `${account.githubUserId}+${account.login}@users.noreply.github.com`;
}

export class SigningKeyUnavailableError extends Error {
  constructor(
    readonly code: 'github_required' | 'locked',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Mint a signing key for one person and store it, the private half encrypted.
 * Only a person with a GitHub connection gets one: the key is useful only once
 * registered with that account, and without one their commits stay internal.
 * Returns only public material.
 */
export async function mintPersonalSigningKey(
  deps: {
    store: GitIdentityStore;
    secretCipher?: SealableSecretCipher | undefined;
    sshKeygen?: SshKeygenSpawner | undefined;
  },
  userId: string,
): Promise<{ publicKey: string }> {
  if (deps.secretCipher?.isSealed() === true) {
    throw new SigningKeyUnavailableError('locked', 'Unlock Verity before creating a signing key');
  }
  const account = await deps.store.userGithubAuthorizations.account(userId);
  if (account === undefined) {
    throw new SigningKeyUnavailableError(
      'github_required',
      'Connect GitHub before creating a signing key',
    );
  }
  const own = await deps.store.userGitIdentities.author(userId);
  const email = own?.authorEmail?.trim() || noreplyEmail(account);
  const generated = await generateSigningKey(email, deps.sshKeygen);
  try {
    await deps.store.userGitIdentities.set(userId, {
      sshPrivateKey: generated.privateKey,
      sshPublicKey: generated.publicKey,
    });
  } catch (error) {
    if (error instanceof SealedError) {
      throw new SigningKeyUnavailableError('locked', 'Unlock Verity before creating a signing key');
    }
    throw error;
  }
  return { publicKey: generated.publicKey };
}

/**
 * A person's own commit identity and signing key (ADR 0023 §3). Every route acts
 * for the signed-in person only; no user id is taken from the request, and the
 * private key never leaves the store.
 */
export function registerGitIdentityRoutes(
  app: FastifyInstance,
  deps: {
    store: GitIdentityStore;
    secretCipher?: SealableSecretCipher | undefined;
    sshKeygen?: SshKeygenSpawner | undefined;
  },
): void {
  const view = async (userId: string) => {
    const [identity, account] = await Promise.all([
      deps.store.userGitIdentities.publicIdentity(userId),
      deps.store.userGithubAuthorizations.account(userId),
    ]);
    return {
      authorName: identity.authorName,
      authorEmail: identity.authorEmail,
      signingKeyConfigured: identity.hasSigningKey,
      publicKey: identity.sshPublicKey,
      githubConnected: account !== undefined,
    };
  };

  app.get('/me/git-identity', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return view(viewerId(request));
  });

  app.put('/me/git-identity', async (request, reply) => {
    const input = identityPatch.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Invalid git identity' });
    const userId = viewerId(request);
    const blankToNull = (value: string | null | undefined) =>
      value === undefined ? undefined : value === null || value.length === 0 ? null : value;
    const authorName = blankToNull(input.data.authorName);
    const authorEmail = blankToNull(input.data.authorEmail);
    // The pair is what a turn commits as; a value that could not be one (or could
    // forge a commit header) is refused here rather than failing a later turn.
    const current = await deps.store.userGitIdentities.author(userId);
    const name = authorName === undefined ? current?.authorName : authorName;
    const email = authorEmail === undefined ? current?.authorEmail : authorEmail;
    if (
      (name !== null && name !== undefined && !isGitAuthor({ name, email: 'check@example.com' })) ||
      (email !== null && email !== undefined && !isGitAuthor({ name: 'check', email }))
    ) {
      return reply.code(400).send({ error: 'Invalid git identity' });
    }
    await deps.store.userGitIdentities.set(userId, {
      ...(authorName !== undefined ? { authorName } : {}),
      ...(authorEmail !== undefined ? { authorEmail } : {}),
    });
    reply.header('cache-control', 'no-store');
    return view(userId);
  });

  app.post('/me/git-identity/signing-key', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      return await mintPersonalSigningKey(deps, viewerId(request));
    } catch (error) {
      if (!(error instanceof SigningKeyUnavailableError)) throw error;
      return reply.code(409).send({ error: error.message, code: error.code });
    }
  });
}
