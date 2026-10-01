import {
  googleContactsRequestSchema,
  invokeGoogleContactsApi,
  type GoogleContactsRequest,
} from './google-contacts.js';
import type { WorkspaceInvocationInput } from './google-workspace-tool-types.js';

export interface GoogleContactsToolStore {
  getSession(sessionId: string): Promise<{ projectId: string | null } | undefined>;
  getSessionContactsConnection(
    sessionId: string,
  ): Promise<{ accountEmail: string; enabledAt: Date } | undefined>;
  getVeritySettings(): Promise<
    | {
        contactsAuthorized: boolean;
        googleDriveRefreshToken: string | null;
        googleDriveAccountEmail: string | null;
      }
    | undefined
  >;
}
export function googleContactsHasStandingAuthorization(request: unknown): boolean {
  const parsed = googleContactsRequestSchema.safeParse(request);
  return parsed.success;
}
export function createGoogleContactsTool(deps: {
  eventStore: GoogleContactsToolStore;
  googleAccessToken: () => Promise<string | undefined>;
  contacts?: (token: string, request: GoogleContactsRequest) => Promise<unknown>;
}): { invoke(input: WorkspaceInvocationInput): Promise<unknown> } {
  const authorized = async (input: WorkspaceInvocationInput) => {
    const session = await deps.eventStore.getSession(input.sessionId);
    const connection = await deps.eventStore.getSessionContactsConnection(input.sessionId);
    const settings = await deps.eventStore.getVeritySettings();
    if (
      session === undefined ||
      session.projectId !== input.projectId ||
      connection === undefined ||
      settings?.contactsAuthorized !== true ||
      !settings.googleDriveRefreshToken?.trim() ||
      settings.googleDriveAccountEmail?.toLowerCase() !== connection.accountEmail.toLowerCase()
    )
      throw new Error('Google Contacts is not enabled for the calling session');
    return {
      email: settings.googleDriveAccountEmail,
      refreshToken: settings.googleDriveRefreshToken,
    };
  };
  return {
    async invoke(input) {
      const credential = await authorized(input);
      const request = googleContactsRequestSchema.parse(input.request);
      const token = await deps.googleAccessToken();
      if (!token) throw new Error('Google Contacts is not connected');
      // Every newly started request must still have the original session grant.
      const verifyCredentialUnchanged = async () => {
        const current = await authorized(input);
        if (
          current.email.toLowerCase() !== credential.email.toLowerCase() ||
          current.refreshToken !== credential.refreshToken
        )
          throw new Error('The connected Google account changed during this operation');
      };
      await verifyCredentialUnchanged();
      const result =
        deps.contacts === undefined
          ? await invokeGoogleContactsApi(token, request, undefined, verifyCredentialUnchanged)
          : await deps.contacts(token, request);

      return result;
    },
  };
}
