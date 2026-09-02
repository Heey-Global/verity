import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  SealedError,
  type EventStore,
  type SealableSecretCipher,
  type VeritySettingsPatch,
  type VeritySettingsRecord,
} from '@verity/store';
import type { GitHubAppIdentityResult } from './github-app-token.js';
import { generateSigningKey, type SshKeygenSpawner } from './signing-key.js';

interface SigningKeyRouteStore extends EventStore {
  getVeritySettingsRaw(): Promise<VeritySettingsRecord | undefined>;
  updateVeritySettings(patch: VeritySettingsPatch): Promise<VeritySettingsRecord>;
}

function hasSigningKeyRouteStore(store: EventStore): store is SigningKeyRouteStore {
  return (
    'getVeritySettingsRaw' in store &&
    typeof store.getVeritySettingsRaw === 'function' &&
    'updateVeritySettings' in store &&
    typeof store.updateVeritySettings === 'function'
  );
}

function signingKeyRouteStore(store: EventStore): SigningKeyRouteStore {
  if (!hasSigningKeyRouteStore(store)) {
    throw new Error('verity settings store methods are not available');
  }
  return store;
}

export interface SigningKeyRouteDeps {
  eventStore: EventStore;
  secretCipher?: SealableSecretCipher | undefined;
  resolveGitHubAppIdentity?: (() => Promise<GitHubAppIdentityResult | undefined>) | undefined;
  sshKeygen?: SshKeygenSpawner | undefined;
}

/** Registers signing-key status and generation settings routes. */
export function registerSigningKeyRoutes(app: FastifyInstance, deps: SigningKeyRouteDeps): void {
  // `GET /settings/signing-key` — the CURRENT signing PUBLIC key, so Settings can
  // re-display it long after onboarding (a common need: registering it on GitHub
  // as a Signing Key). Public material only, read from the non-decrypting raw
  // settings, so it works even while the secret store is SEALED. `configured`
  // reflects whether a signing private key (DB contents or a file path) is set.
  app.get(
    '/settings/signing-key',
    async (): Promise<{ configured: boolean; publicKey: string | null }> => {
      const raw = await signingKeyRouteStore(deps.eventStore).getVeritySettingsRaw();
      const nonEmpty = (value: unknown): value is string =>
        typeof value === 'string' && value.trim().length > 0;
      const publicKey = nonEmpty(raw?.gitSshPublicKey) ? raw.gitSshPublicKey.trim() : null;
      const configured =
        nonEmpty(raw?.gitSshPrivateKey) ||
        nonEmpty(raw?.gitSshPrivateKeyPath) ||
        publicKey !== null;
      return { configured, publicKey };
    },
  );

  // ── SSH signing-key generation (#320, onboarding) ─────────────────────────
  // `POST /settings/signing-key/generate` — generate an ed25519 OpenSSH-format
  // signing keypair server-side, store the PRIVATE key encrypted at rest, and
  // return ONLY the public material (pubkey + derived allowed_signers line). The
  // operator's sole manual step afterward is adding the pubkey to GitHub as a
  // Signing Key. Requires the cipher UNSEALED (it must encrypt the private key to
  // store it) — sealed → `{ ok: false, error: 'locked' }` WITHOUT throwing. The
  // PRIVATE key NEVER appears in the response or the logs.
  // Optional caller-supplied git identity. The onboarding wizard sends these so the
  // operator can enter a PERSONAL name/email — required when the GitHub App is an
  // ORGANIZATION installation, which cannot yield a signing identity (see
  // resolveGitHubAppIdentity / github-app-token.ts). When an email is supplied it
  // takes precedence and the App-identity derivation is skipped entirely.
  const signingKeyGenerateBody = z.object({
    gitUserName: z.string().trim().min(1).max(200).optional(),
    gitUserEmail: z.string().trim().min(3).max(320).optional(),
  });

  app.post(
    '/settings/signing-key/generate',
    async (
      request,
    ): Promise<{
      ok: boolean;
      publicKey?: string;
      allowedSigners?: string;
      error?: string;
    }> => {
      // Sealed → can't encrypt the private key to store it. Report locked without
      // throwing (the wizard shows "unlock first", not a 5xx).
      if (deps.secretCipher?.isSealed() === true) return { ok: false, error: 'locked' };

      const body = signingKeyGenerateBody.parse(request.body ?? {});
      const bodyName =
        body.gitUserName !== undefined && body.gitUserName.length > 0 ? body.gitUserName : null;
      const bodyEmail =
        body.gitUserEmail !== undefined && body.gitUserEmail.length > 0 ? body.gitUserEmail : null;

      const store = signingKeyRouteStore(deps.eventStore);
      // The (plaintext) git email is the key comment + allowed_signers principal.
      // Caller-supplied identity wins over stored, and stored wins over App-derived.
      const raw = await store.getVeritySettingsRaw();
      let name = bodyName ?? raw?.gitUserName ?? null;
      let email = bodyEmail ?? raw?.gitUserEmail ?? null;

      // Derive the committer identity from the GitHub App installation when it is
      // not already set — so it matches an account that can hold the signing key
      // (a user account's no-reply email), which is what makes GitHub mark the
      // signed commits "Verified". An organization installation cannot yield a
      // signing identity; surface that as an error instead of a broken key.
      if ((email === null || email.length === 0) && deps.resolveGitHubAppIdentity !== undefined) {
        const identity = await deps.resolveGitHubAppIdentity();
        if (identity !== undefined && !identity.ok) {
          return { ok: false, error: identity.error ?? 'could not derive git identity' };
        }
        if (identity?.ok === true) {
          // Only fill fields that are actually empty — never overwrite a name the
          // operator set just because the email was blank.
          if (name === null || name.length === 0) name = identity.name ?? null;
          email = identity.email ?? null;
        }
      }

      // Generate the keypair in a private temp dir (0700), cleaned up even on
      // failure. Only the PUBLIC material leaves this scope on the wire.
      const generated = await generateSigningKey(email, deps.sshKeygen);

      // Persist the keys + the derived allowed_signers (and the derived identity) —
      // the private key encrypted at rest via updateVeritySettings. allowed_signers
      // is what the provisioner mounts to `.ssh/allowed_signers` for local
      // signature verification; storing it here (not just returning it on the wire)
      // is what makes that mount work.
      try {
        await store.updateVeritySettings({
          ...(name !== null && name.length > 0 ? { gitUserName: name } : {}),
          ...(email !== null && email.length > 0 ? { gitUserEmail: email } : {}),
          gitSshPrivateKey: generated.privateKey,
          gitSshPublicKey: generated.publicKey,
          gitAllowedSigners: generated.allowedSigners,
        });
      } catch (err) {
        // A racing seal between the read and the write surfaces as SealedError —
        // degrade to `locked` rather than a 5xx, matching the validate route.
        if (err instanceof SealedError) return { ok: false, error: 'locked' };
        throw err;
      }

      // Return ONLY the public material. The private key is deliberately absent
      // from this object so it can never be serialized onto the wire.
      return {
        ok: true,
        publicKey: generated.publicKey,
        allowedSigners: generated.allowedSigners,
      };
    },
  );
}
