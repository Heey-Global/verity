import type { EventStore } from '@verity/store';
import {
  hasGoogleGmailScopes,
  hasGoogleCalendarScopes,
  hasGoogleContactsScopes,
} from './google-oauth-scopes.js';

export type GoogleServiceCredentialStore = Partial<Pick<EventStore, 'getGoogleServiceCredentials'>>;
const checks = {
  gmail: hasGoogleGmailScopes,
  calendar: hasGoogleCalendarScopes,
  contacts: hasGoogleContactsScopes,
};
export async function resolveGoogleServiceCredential(
  store: GoogleServiceCredentialStore,
  sessionId: string,
  service: keyof typeof checks,
) {
  const credential = await store.getGoogleServiceCredentials?.(sessionId, service);
  if (!credential || !checks[service](credential.scopes))
    throw new Error(`Google ${service} is not enabled for this session`);
  return credential;
}
