// Guided first-run onboarding status (#320, PR 1: status endpoint + gating shell).
//
// `GET /onboarding/status` is the gate the mobile app polls on launch to decide
// whether to route the operator into the setup wizard. It MUST answer while the
// secret store is still SEALED (pre-unlock) — it is itself the pre-unlock gate —
// so every read here is a NON-decrypting store read:
//   - the cipher's sealed flag (same source `/secret/status` reports),
//   - `getSecretKeyMeta()` presence (a master password was initialized),
//   - `getVeritySettingsRaw()` (reads the STORED, possibly-encrypted columns and
//     only checks presence — never treats them as plaintext, never decrypts),
//   - `listProjects({ includeHidden: true })` length.
// None of these touch `getVeritySettings()` (which decrypts) or any secret value.
import type { EventStore, SealableSecretCipher } from '@verity/store';
import type { FastifyInstance } from 'fastify';

/**
 * The ordered required-then-optional onboarding steps the status endpoint reasons
 * about. `nextStep` is the first INCOMPLETE required step in this order; Doppler is
 * optional and never blocks `complete`.
 */
export type OnboardingStep = 'master-password' | 'github' | 'first-project';

export interface OnboardingStatus {
  /** The at-rest cipher is sealed (no key loaded). Mirrors `/secret/status`. */
  sealed: boolean;
  /** A master password was set (key-derivation meta present) — sealed-safe read. */
  masterPasswordSet: boolean;
  /** GitHub App id + installation id + private key are all present (presence only). */
  githubAppConfigured: boolean;
  /** A commit-signing key is present: inline SSH key OR a key path (presence only). */
  signingKeyConfigured: boolean;
  /** At least one project row exists (hidden included — the bootstrap check). */
  hasProject: boolean;
  /** An account-level Doppler Service Account token is present (presence only).
   *  INFORMATIONAL — Doppler is optional, so this NEVER gates `complete` or
   *  `nextStep`. */
  dopplerConfigured: boolean;
  /** A Claude Code subscription login (credentials JSON) is stored (presence only).
   *  INFORMATIONAL — optional, NEVER gates `complete`/`nextStep`. */
  claudeConfigured: boolean;
  /** A Codex subscription credential is stored (presence only).
   *  INFORMATIONAL — optional, same rationale as {@link claudeConfigured}. */
  codexConfigured: boolean;
  /** All REQUIRED steps done (Doppler and backend logins are optional, excluded). */
  complete: boolean;
  /** First incomplete required step, or `null` once complete. */
  nextStep: OnboardingStep | null;
}

/** Non-empty after trimming — the presence test used for every raw secret column. */
function present(value: string | null | undefined): boolean {
  return Boolean(value?.trim());
}

/**
 * Derive the onboarding status from NON-decrypting store reads + the cipher's
 * sealed flag. Pure over its inputs (the two async store calls it awaits) so the
 * route handler is a thin wrapper and the logic is unit-testable directly.
 */
export async function computeOnboardingStatus(
  store: EventStore,
  cipher: SealableSecretCipher | undefined,
): Promise<OnboardingStatus> {
  // No managed cipher → treat as never-sealed (an env-key/unmanaged deployment is
  // effectively always unlocked). `sealed` only reflects a real sealable cipher.
  const sealed = cipher?.isSealed() ?? false;

  const [keyMeta, settings, projects] = await Promise.all([
    store.getSecretKeyMeta(),
    store.getVeritySettingsRaw(),
    store.listProjects({ includeHidden: true }),
  ]);

  const masterPasswordSet = keyMeta !== undefined;
  const githubAppConfigured =
    present(settings?.githubAppId) &&
    present(settings?.githubAppInstallationId) &&
    present(settings?.githubAppPrivateKey);
  const signingKeyConfigured =
    present(settings?.gitSshPrivateKey) || present(settings?.gitSshPrivateKeyPath);
  const hasProject = projects.some((project) => project.state !== 'absent');
  // INFORMATIONAL only (Doppler is optional): presence of the raw (non-decrypted)
  // account token column. Deliberately NOT part of `complete`/`nextStep`.
  const dopplerConfigured = present(settings?.dopplerServiceToken);
  const claudeConfigured = present(settings?.claudeCodeOauthCredentialsJson);
  const codexConfigured = present(settings?.codexAuthJson);

  const complete = masterPasswordSet && githubAppConfigured && signingKeyConfigured && hasProject;

  // First incomplete REQUIRED step, in fixed order. Doppler is optional and never
  // appears here (so it never blocks `complete` or drives `nextStep`).
  const nextStep: OnboardingStep | null = !masterPasswordSet
    ? 'master-password'
    : !githubAppConfigured || !signingKeyConfigured
      ? 'github'
      : !hasProject
        ? 'first-project'
        : null;

  return {
    sealed,
    masterPasswordSet,
    githubAppConfigured,
    signingKeyConfigured,
    hasProject,
    dopplerConfigured,
    claudeConfigured,
    codexConfigured,
    complete,
    nextStep,
  };
}

/**
 * Register `GET /onboarding/status` on the server. Called from `buildServer`
 * beside the `/secret` lifecycle routes (same inline registration style). The
 * endpoint never writes and never decrypts, so it is safe to hit while sealed.
 */
export function registerOnboardingRoutes(
  app: FastifyInstance,
  deps: { eventStore: EventStore; secretCipher: SealableSecretCipher | undefined },
): void {
  app.get('/onboarding/status', (): Promise<OnboardingStatus> => {
    return computeOnboardingStatus(deps.eventStore, deps.secretCipher);
  });
}
