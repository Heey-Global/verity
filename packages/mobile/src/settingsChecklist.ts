// The required-setup checklist that heads the Settings index.
//
// It answers one question — what still has to be done before Verity can do its
// job — and it has to answer it from the SAME booleans the individual cards show
// as status pills. A header computed from a second source (say the onboarding
// step machine) drifts: the header says "all set" while a card two taps away
// says "Needs setup", and the operator has no way to tell which one is lying.
// So the predicates below are exported and the screens consume them directly;
// the checklist is just those predicates collected in order.
//
// The other rule this encodes: a checklist that could not be computed says so.
// "0 to do" is a claim about the deployment, and while the fetch is in flight or
// failed there is nothing to base it on.
import type { SecretStatus, VeritySettings } from './api.js';

/** Steps that gate a working Verity. Optional integrations (Doppler, AI backend
 *  logins, transcription, MCP) are deliberately absent: they are opt-in, and
 *  counting them would leave the header permanently unfinished. */
export type SettingsChecklistItemId =
  'secretStore' | 'githubAccess' | 'commitAuthor' | 'verifiedCommits';

export type SettingsChecklistItem = {
  id: SettingsChecklistItemId;
  /** Names the thing, not the action — the row pairs it with a status pill. */
  title: string;
  /** One line on what it unlocks, shown while the step is outstanding. */
  detail: string;
  done: boolean;
};

export type SettingsChecklist =
  /** No answer yet — the settings or secret-store fetch is still in flight. */
  | { kind: 'loading' }
  /** The fetch failed. Never render a count from this state. */
  | { kind: 'unavailable' }
  | { kind: 'ready'; items: SettingsChecklistItem[]; remaining: number };

export type SettingsChecklistInput = {
  settings: VeritySettings | null;
  secretStatus: SecretStatus | undefined;
  /** A fetch behind either input failed, so the data on hand may be incomplete. */
  failed: boolean;
};

/** Whether this deployment keeps an encrypted secret store at all. `unmanaged`
 *  means the cipher is someone else's job (env-injected credentials), and the
 *  step drops out of the checklist rather than sitting there unachievable. */
export function secretStoreManaged(status: SecretStatus | undefined): boolean {
  return status !== undefined && status !== 'unmanaged';
}

/** Secrets are loaded and readable by project containers. */
export function secretStoreReady(status: SecretStatus | undefined): boolean {
  return status === 'unlocked';
}

/**
 * GitHub can mint an installation token — clone, push, open pull requests.
 *
 * All three parts of the App credential are required: an installation id with no
 * private key mints nothing, so a partial configuration must read as "not
 * connected" rather than promise access the server cannot obtain.
 */
export function githubRepositoryAccessReady(settings: VeritySettings | null): boolean {
  if (settings === null) return false;
  return (
    settings.githubAppPrivateKeyConfigured &&
    settings.githubAppId !== null &&
    settings.githubAppInstallationId !== null
  );
}

/** A commit author is set, so commits are attributed to a person rather than to
 *  whatever git falls back to inside the container. */
export function commitAuthorReady(settings: VeritySettings | null): boolean {
  if (settings === null) return false;
  return (
    (settings.gitUserName ?? '').trim().length > 0 &&
    (settings.gitUserEmail ?? '').trim().length > 0
  );
}

/** Verity holds signing material, so its commits can verify on GitHub. Either a
 *  key in the secret store or a deployment-level key path counts — both end up
 *  as the same `user.signingkey` inside the container. */
export function verifiedCommitsReady(settings: VeritySettings | null): boolean {
  if (settings === null) return false;
  return settings.gitSshPrivateKeyConfigured || (settings.gitSshPrivateKeyPath ?? '').trim() !== '';
}

/** The required-setup checklist for the Settings index header. */
export function settingsChecklist(input: SettingsChecklistInput): SettingsChecklist {
  if (input.failed) return { kind: 'unavailable' };
  if (input.settings === null || input.secretStatus === undefined) return { kind: 'loading' };

  const items: SettingsChecklistItem[] = [];
  if (secretStoreManaged(input.secretStatus)) {
    items.push({
      id: 'secretStore',
      title: 'Secret store',
      detail: 'Unlock it so project containers can read stored credentials.',
      done: secretStoreReady(input.secretStatus),
    });
  }
  items.push({
    id: 'githubAccess',
    title: 'GitHub repository access',
    detail: 'Let Verity clone repositories, push branches, and open pull requests.',
    done: githubRepositoryAccessReady(input.settings),
  });
  items.push({
    id: 'commitAuthor',
    title: 'Commit author',
    detail: 'Set the name and GitHub-verified email Verity should write to commits.',
    done: commitAuthorReady(input.settings),
  });
  items.push({
    id: 'verifiedCommits',
    title: 'Verified commits',
    detail: 'Add the signing key to GitHub so Verity’s commits verify.',
    done: verifiedCommitsReady(input.settings),
  });

  return { kind: 'ready', items, remaining: items.filter((item) => !item.done).length };
}

/** The header's one line. Kept next to the computation so the "0 to do" case —
 *  which must never be rendered — cannot be reintroduced at a call site. */
export function settingsChecklistHeadline(checklist: SettingsChecklist): string {
  switch (checklist.kind) {
    case 'loading':
      return 'Checking setup…';
    case 'unavailable':
      return 'Couldn’t load settings';
    case 'ready':
      return checklist.remaining === 0 ? 'All set' : `Setup · ${String(checklist.remaining)} to do`;
  }
}
