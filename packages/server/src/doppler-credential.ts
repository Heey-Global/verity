import { DopplerSecretResolutionError } from './doppler-secret-resolver.js';

/** Shown to the agent and in the transcript when a person has not connected Doppler. */
export const DOPPLER_CONNECTION_REQUIRED_MESSAGE =
  'Secret resolution failed during Doppler connection: connect your own Doppler token for ' +
  "this project in Verity (project settings, Doppler). The administrator's Doppler token " +
  'is never used for your turns. No secret value was exposed.';

export function dopplerConnectionRequired(): DopplerSecretResolutionError {
  return new DopplerSecretResolutionError(
    DOPPLER_CONNECTION_REQUIRED_MESSAGE,
    'Doppler connection',
  );
}

export interface DopplerCredentialSources {
  /** The person's own token for the project, as erasable bytes. */
  personal(userId: string, projectId: string): Promise<Buffer | undefined>;
  /** The instance token, which was the administrator's. */
  instance(): Promise<Buffer | undefined>;
  isAdministrator(userId: string): Promise<boolean>;
}

/**
 * The single rule for whose Doppler token resolves a project's secrets (ADR 0023
 * §3): the person's own connection for the project; the instance token only for
 * the active administrator, whose token it was; anyone else gets a connect
 * prompt, never another person's token. `null` is a turn without a person — only
 * a pre-multi-user session or an administrator's legacy device creates one — and
 * keeps the project default, the instance token, as GitHub and signing do.
 */
export function createDopplerCredentials(sources: DopplerCredentialSources) {
  return async (userId: string | null, projectId: string): Promise<Buffer> => {
    if (userId !== null) {
      const own = await sources.personal(userId, projectId);
      if (own !== undefined) return own;
      if (!(await sources.isAdministrator(userId))) throw dopplerConnectionRequired();
    }
    const instance = await sources.instance();
    if (instance === undefined) {
      throw new DopplerSecretResolutionError(
        'Secret resolution failed during Doppler authentication. No secret value was exposed.',
        'Doppler authentication',
      );
    }
    return instance;
  };
}

/** Whose connection resolves a secret: a running turn's person, or a fixed person
 *  (such as whoever started a dev server; null for none). */
export type DopplerPerson =
  { readonly sessionId: string; readonly turnId: string } | { readonly userId: string | null };

export type DopplerCredentialFor = ReturnType<typeof createDopplerCredentials>;
