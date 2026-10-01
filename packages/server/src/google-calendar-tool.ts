import {
  googleCalendarRequestSchema,
  invokeGoogleCalendarApi,
  type GoogleCalendarRequest,
} from './google-calendar.js';
import type { WorkspaceInvocationInput } from './google-workspace-tool-types.js';

export interface GoogleCalendarToolStore {
  getSession(sessionId: string): Promise<{ projectId: string | null } | undefined>;
  getSessionCalendarConnection(
    sessionId: string,
  ): Promise<{ accountEmail: string; enabledAt: Date } | undefined>;
  getVeritySettings(): Promise<
    | {
        calendarAuthorized: boolean;
        googleDriveRefreshToken: string | null;
        googleDriveAccountEmail: string | null;
      }
    | undefined
  >;
  claimGoogleWorkspaceInvocation(
    input: WorkspaceInvocationInput,
  ): Promise<
    { status: 'claimed' } | { status: 'pending' } | { status: 'completed'; result: unknown }
  >;
  completeGoogleWorkspaceInvocation(invocationId: string, result: unknown): Promise<void>;
}
export function googleCalendarHasStandingAuthorization(request: unknown): boolean {
  const parsed = googleCalendarRequestSchema.safeParse(request);
  return (
    parsed.success && ['list_calendars', 'list_events', 'read_event'].includes(parsed.data.action)
  );
}
export function createGoogleCalendarTool(deps: {
  eventStore: GoogleCalendarToolStore;
  googleAccessToken: () => Promise<string | undefined>;
  calendar?: (token: string, request: GoogleCalendarRequest) => Promise<unknown>;
}): { invoke(input: WorkspaceInvocationInput): Promise<unknown> } {
  const authorized = async (input: WorkspaceInvocationInput) => {
    const session = await deps.eventStore.getSession(input.sessionId);
    const connection = await deps.eventStore.getSessionCalendarConnection(input.sessionId);
    const settings = await deps.eventStore.getVeritySettings();
    if (
      session === undefined ||
      session.projectId !== input.projectId ||
      connection === undefined ||
      settings?.calendarAuthorized !== true ||
      !settings.googleDriveRefreshToken?.trim() ||
      settings.googleDriveAccountEmail?.toLowerCase() !== connection.accountEmail.toLowerCase()
    )
      throw new Error('Google Calendar is not enabled for the calling session');
    return {
      email: settings.googleDriveAccountEmail,
      refreshToken: settings.googleDriveRefreshToken,
    };
  };
  return {
    async invoke(input) {
      const credential = await authorized(input);
      const request = googleCalendarRequestSchema.parse(input.request);
      const token = await deps.googleAccessToken();
      if (!token) throw new Error('Google Calendar is not connected');
      const mutation = !googleCalendarHasStandingAuthorization(request);
      if (mutation) {
        const claim = await deps.eventStore.claimGoogleWorkspaceInvocation(input);
        if (claim.status === 'completed') return claim.result;
        if (claim.status === 'pending')
          throw new Error(
            'This Calendar change may already have happened; check the event before retrying',
          );
      }
      // A disconnect or account switch while obtaining a token must invalidate the call.
      const current = await authorized(input);
      if (
        current.email.toLowerCase() !== credential.email.toLowerCase() ||
        current.refreshToken !== credential.refreshToken
      )
        throw new Error('The connected Google account changed during this operation');
      const result = await (deps.calendar ?? invokeGoogleCalendarApi)(token, request);
      if (mutation)
        await deps.eventStore.completeGoogleWorkspaceInvocation(input.invocationId, result);
      return result;
    },
  };
}
