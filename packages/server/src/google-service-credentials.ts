import type { EventStore } from '@verity/store';
import {
  hasGoogleGmailScopes,
  hasGoogleCalendarScopes,
  hasGoogleContactsScopes,
} from './google-oauth-scopes.js';

export type GoogleServiceCredentialStore = Partial<
  Pick<EventStore, 'getGoogleServiceCredentials' | 'runningTurnInitiator'>
>;
const checks = {
  gmail: hasGoogleGmailScopes,
  calendar: hasGoogleCalendarScopes,
  contacts: hasGoogleContactsScopes,
};
export async function resolveGoogleServiceCredential(
  store: GoogleServiceCredentialStore,
  sessionId: string,
  service: keyof typeof checks,
  /** The person the calling turn runs for; their own account only. */
  userId: string | undefined,
) {
  const credential = await store.getGoogleServiceCredentials?.(sessionId, service, userId);
  if (!credential || !checks[service](credential.scopes))
    throw new Error(`Google ${service} is not enabled for this session`);
  return credential;
}

/** The Google credential of the person the calling turn runs for. A turn that is
 *  not the session's running one, or has no initiator, gets none. */
export async function resolveGoogleServiceCredentialForTurn(
  store: GoogleServiceCredentialStore,
  sessionId: string,
  turnId: string,
  service: keyof typeof checks,
) {
  const initiator = await store.runningTurnInitiator?.(sessionId, turnId);
  return resolveGoogleServiceCredential(store, sessionId, service, initiator?.userId);
}
