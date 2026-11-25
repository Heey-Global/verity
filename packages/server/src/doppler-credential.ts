import {
  DopplerTokenRevalidationRequiredError,
  type DopplerTokenBindingScope,
  type EventStore,
} from '@verity/store';

import { DopplerSecretResolutionError } from './doppler-secret-resolver.js';
import { personForCredential } from './personless-credential.js';

/** Shown to the agent and in the transcript when a person has not connected Doppler. */
export const DOPPLER_CONNECTION_REQUIRED_MESSAGE =
  'Secret resolution failed during Doppler connection: connect your own Doppler token for ' +
  "this project in Verity (project settings, Doppler). The administrator's Doppler token " +
  'is never used for your turns. No secret value was exposed.';

/** A fixed text: connection labels are administrator-written and stay out of the
 *  agent's context; project settings name the connection that needs a token. */
export function dopplerConnectionRequired(): DopplerSecretResolutionError {
  return new DopplerSecretResolutionError(
    DOPPLER_CONNECTION_REQUIRED_MESSAGE,
    'Doppler connection',
  );
}

export interface DopplerCredentialSources {
  /** The person's own token for the project and connection, as erasable bytes. */
  personal(
    userId: string,
    projectId: string,
    connectionId: string,
    // Required: an unscoped read would skip the per-config validation of the token.
    scope: DopplerTokenBindingScope,
  ): Promise<Buffer | undefined>;
  /** The connection's instance token, which is the administrator's. */
  instance(connectionId: string): Promise<Buffer | undefined>;
  isAdministrator(userId: string): Promise<boolean>;
  /** Whose credentials serve work without a person (`personForCredential`);
   *  throws where none may. */
  personless(projectId: string): Promise<string>;
}

/**
 * The single rule for whose Doppler token resolves a project's secrets (ADR 0023
 * §3), per Doppler connection (ADR 0031): the person's own token for the project
 * and connection; the connection's instance token only for the active
 * administrator, whose token it is; anyone else gets a connect prompt, never another person's token. `null` is work without a person,
 * served as the original sandbox's person only where `personForCredential` allows it.
 */
export function createDopplerCredentials(sources: DopplerCredentialSources) {
  return async (
    person: string | null,
    projectId: string,
    connectionId: string,
    scope: DopplerTokenBindingScope,
  ): Promise<Buffer> => {
    const userId = person ?? (await sources.personless(projectId));
    let own: Buffer | undefined;
    try {
      own = await sources.personal(userId, projectId, connectionId, scope);
    } catch (error) {
      if (!(error instanceof DopplerTokenRevalidationRequiredError)) throw error;
      throw new DopplerSecretResolutionError(
        'Secret resolution failed during Doppler connection: reconnect your own Doppler token in project settings to validate access to this config. No secret value was exposed.',
        'Doppler connection',
      );
    }
    if (own !== undefined) return own;
    if (!(await sources.isAdministrator(userId))) throw dopplerConnectionRequired();
    const instance = await sources.instance(connectionId);
    if (instance === undefined) {
      throw new DopplerSecretResolutionError(
        'Secret resolution failed during Doppler authentication. No secret value was exposed.',
        'Doppler authentication',
      );
    }
    return instance;
  };
}

/** `createDopplerCredentials` over the store, with the instance token as stored. */
export function createStoreDopplerCredentials(store: EventStore) {
  return createDopplerCredentials({
    personal: (userId, projectId, connectionId, scope) =>
      store.userDopplerConnections.tokenBytes(userId, projectId, connectionId, scope),
    instance: (connectionId) => store.dopplerConnections.tokenBytes(connectionId),
    isAdministrator: (userId) => store.isActiveAdministrator(userId),
    personless: async (projectId) => {
      try {
        return await personForCredential(store, projectId, null);
      } catch (error) {
        throw new DopplerSecretResolutionError(
          `${(error as Error).message} No secret value was exposed.`,
          'Doppler connection',
        );
      }
    },
  });
}

/** Whose connection resolves a secret: a running turn's person, or a fixed person
 *  (such as whoever started a dev server; null for none). */
export type DopplerPerson =
  { readonly sessionId: string; readonly turnId: string } | { readonly userId: string | null };
