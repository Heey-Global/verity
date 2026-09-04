import type { FastifyInstance } from 'fastify';
import { SealedError, type SealableSecretCipher, type VeritySettingsRecord } from '@verity/store';
import type { GitHubAppCreds, GitHubAppValidateResult } from './github-app-token.js';

interface GitHubAppRouteStore {
  getVeritySettings(): Promise<VeritySettingsRecord | undefined>;
}

export interface GitHubAppRouteDeps {
  store: () => GitHubAppRouteStore;
  secretCipher?: SealableSecretCipher | undefined;
  validate?: ((creds: GitHubAppCreds) => Promise<GitHubAppValidateResult>) | undefined;
}

/** Registers GitHub App credential validation used during onboarding. */
export function registerGitHubAppRoutes(app: FastifyInstance, deps: GitHubAppRouteDeps): void {
  app.post('/github/app/validate', async (): Promise<GitHubAppValidateResult> => {
    // The private key cannot be decrypted while sealed. Return a wizard-facing
    // state instead of turning the expected locked state into a server error.
    if (deps.secretCipher?.isSealed() === true) return { ok: false, error: 'locked' };
    if (deps.validate === undefined) return { ok: false, error: 'not configured' };

    let settings;
    try {
      settings = await deps.store().getVeritySettings();
    } catch (error) {
      // A seal racing the initial state check has the same public result.
      if (error instanceof SealedError) return { ok: false, error: 'locked' };
      throw error;
    }
    if (
      !settings?.githubAppId ||
      !settings.githubAppInstallationId ||
      !settings.githubAppPrivateKey
    ) {
      return { ok: false, error: 'not configured' };
    }

    // The validator's result is redaction-safe; neither token nor private key is
    // returned or logged by this route.
    return deps.validate({
      appId: settings.githubAppId,
      installationId: settings.githubAppInstallationId,
      privateKey: settings.githubAppPrivateKey,
    });
  });
}
