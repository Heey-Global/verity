import type { EventStore } from '@verity/store';
import { createStoreDopplerCredentials, type DopplerPerson } from './doppler-credential.js';
import { DopplerSecretResolutionError } from './doppler-secret-resolver.js';
import { validateDopplerToken, listDopplerProjects, listDopplerConfigs } from './doppler-token.js';

export function createEmbeddedDoppler(eventStore: EventStore) {
  // The administrator's instance token; only the instance-level Doppler routes and
  // the per-person rule below read it.
  const readBrokerDopplerCredential = (): Promise<Buffer | undefined> =>
    eventStore.getDopplerServiceTokenBytes();
  // ADR 0023 §3: a project's secrets resolve through the Doppler connection of the
  // person the work is for; see doppler-credential.ts.
  const dopplerCredentialFor = createStoreDopplerCredentials(eventStore);
  /** The person a turn acts for while it runs; null for a turn without one. A turn
   *  that is no longer running resolves nothing. */
  const runningTurnPerson = async (sessionId: string, turnId: string): Promise<string | null> => {
    const running = (await eventStore.listRunningTurns()).find(
      (turn) => turn.sessionId === sessionId,
    );
    if (running === undefined || running.turnId !== turnId) {
      throw new DopplerSecretResolutionError(
        'Secret resolution failed during project configuration. No secret value was exposed.',
        'project configuration',
      );
    }
    return (await eventStore.promptInitiatorAt(sessionId, running.promptSeq))?.userId ?? null;
  };
  const dopplerPersonId = (person: DopplerPerson): Promise<string | null> =>
    'userId' in person
      ? Promise.resolve(person.userId)
      : runningTurnPerson(person.sessionId, person.turnId);

  const serverDeps = {
    // Live Doppler Service Account token validation for the OPTIONAL onboarding
    // Doppler step (#320). The route reads + decrypts the stored token itself
    // (unsealed-only) and hands it here; this just performs the redaction-safe
    // list-projects check against Doppler.
    dopplerValidate: (token: string) => validateDopplerToken(token),
    dopplerCredentialReader: readBrokerDopplerCredential,
    // Live Doppler project/config listing for the binding picker (#320). Both read
    // the account token from the decrypting route (unsealed-only) and list from
    // that TRUSTED token — NOT repo content (closes the confused-deputy). Both are
    // contractually redaction-safe: never log/echo the token; return only the
    // NON-secret slug/name summaries.
    dopplerListProjects: (token: string) => listDopplerProjects(token),
    dopplerListConfigs: (token: string, project: string) => listDopplerConfigs(token, project),
  };

  return { dopplerCredentialFor, dopplerPersonId, serverDeps };
}
