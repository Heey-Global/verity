// Pure helpers for the mobile Settings screen's secret-store + GitHub-App/SSH
// paste fields. Kept here (next to the Verity client + `VeritySettings`) so the
// non-trivial logic — status→ui-mode mapping, master-password validation, and the
// draft→patch builder for the new write-only secret fields — is unit-tested by the
// existing vitest run without pulling in React Native. The `settings.tsx` screen
// is a thin consumer of these; it never re-implements the rules below.
import type { VeritySettingsPatch, SecretStatus } from './api.js';

/** How the secret-store section renders for a given {@link SecretStatus}:
 *  `set` = first-run password+confirm form; `unlock` = password form; `ready` =
 *  a small "Unlocked" pill; `hidden` = nothing (deployment manages no cipher). */
export type SecretUiMode = 'set' | 'unlock' | 'ready' | 'hidden';

/** Map the server's secret-store status to the section's UI mode. `uninitialized`
 *  → onboarding (`set`), `sealed` → `unlock`, `unlocked` → `ready`, `unmanaged` →
 *  `hidden`. Exhaustive over the enum so a new status is a compile error here. */
export function secretUiMode(status: SecretStatus): SecretUiMode {
  switch (status) {
    case 'uninitialized':
      return 'set';
    case 'sealed':
      return 'unlock';
    case 'unlocked':
      return 'ready';
    case 'unmanaged':
      return 'hidden';
  }
}

/** True when secret VALUES may be written: only once the store is unlocked. A
 *  write while `sealed`/`uninitialized` 503s server-side, so the screen disables
 *  the secret fields' save and shows an "unlock first" hint in the other modes. */
export function secretWritable(status: SecretStatus): boolean {
  return status === 'unlocked';
}

/** Minimum master-password length enforced client-side before {@link initSecretPassword}. */
export const MIN_MASTER_PASSWORD_LENGTH = 12;

/** Inline validation for the first-run master-password form. Returns `null` when
 *  the pair is acceptable, or a short message for the offending field otherwise.
 *  Enforces a minimum length and a matching confirmation — never logs the values. */
export function validateMasterPassword(password: string, confirm: string): string | null {
  if (password.length < MIN_MASTER_PASSWORD_LENGTH) {
    return `Use at least ${String(MIN_MASTER_PASSWORD_LENGTH)} characters.`;
  }
  if (new Set(password).size < 5) {
    return 'Use a more varied passphrase.';
  }
  if (password !== confirm) {
    return 'Passwords do not match.';
  }
  return null;
}

/** The new-field slice of the Settings draft the screen binds to. `githubAppId` /
 *  `githubAppInstallationId` are plain identifiers; the three `*Key` fields are
 *  write-only PEM paste boxes — empty means "leave the configured secret as-is". */
export type SecretSettingsDraft = {
  githubAppId: string;
  githubAppInstallationId: string;
  githubAppPrivateKey: string;
  gitSshPrivateKey: string;
  /** Subscription-login credentials for the sandbox AI backends (connect flow):
   *  Codex still accepts `~/.codex/auth.json` as an advanced paste path. Claude is
   *  connected through the provider login flow so Verity stores the full
   *  `~/.claude/.credentials.json`. */
  codexAuthJson: string;
  /** Doppler account-level Service Account token (`dp.sa.…`). Write-only paste box —
   *  empty = leave the stored token as-is. Set during onboarding OR later here; the
   *  server validates it via {@link VerityClient.validateDoppler} once stored. */
  dopplerServiceToken: string;
  /** Paid Preview subscription key. Write-only and encrypted at rest. */
  uplinkSubscriptionKey: string;
  /** OpenAI-compatible transcription token. Write-only; an empty draft keeps
   * the currently configured token unchanged. */
  transcribeApiKey: string;
};

function trimOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Build the patch fragment for the new secret/App fields.
 *
 * - The non-secret identifiers (`githubAppId`, `githubAppInstallationId`) are
 *   ALWAYS included (trimmed → `null` when blank) so clearing them persists.
 * - The write-only secret values (`githubAppPrivateKey`, `gitSshPrivateKey`) are
 *   included ONLY when their paste field is non-empty — an empty box must never
 *   overwrite an already-configured secret with `null`.
 *
 * Merge the result into the base settings patch before PATCH /settings.
 */
export function secretPatchFromDraft(draft: SecretSettingsDraft): VeritySettingsPatch {
  const patch: VeritySettingsPatch = {
    githubAppId: trimOrNull(draft.githubAppId),
    githubAppInstallationId: trimOrNull(draft.githubAppInstallationId),
  };
  const githubAppPrivateKey = draft.githubAppPrivateKey.trim();
  if (githubAppPrivateKey.length > 0) {
    patch.githubAppPrivateKey = githubAppPrivateKey;
  }
  const gitSshPrivateKey = draft.gitSshPrivateKey.trim();
  if (gitSshPrivateKey.length > 0) {
    patch.gitSshPrivateKey = gitSshPrivateKey;
  }
  const codexAuthJson = draft.codexAuthJson.trim();
  if (codexAuthJson.length > 0) {
    patch.codexAuthJson = codexAuthJson;
  }
  const dopplerServiceToken = draft.dopplerServiceToken.trim();
  if (dopplerServiceToken.length > 0) {
    patch.dopplerServiceToken = dopplerServiceToken;
  }
  const uplinkSubscriptionKey = draft.uplinkSubscriptionKey.trim();
  if (uplinkSubscriptionKey.length > 0) patch.uplinkSubscriptionKey = uplinkSubscriptionKey;
  const transcribeApiKey = draft.transcribeApiKey.trim();
  if (transcribeApiKey.length > 0) {
    patch.transcribeApiKey = transcribeApiKey;
  }
  return patch;
}
