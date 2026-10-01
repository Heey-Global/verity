import { describe, expect, it, vi } from 'vitest';
import {
  createGoogleCalendarTool,
  googleCalendarHasStandingAuthorization,
  type GoogleCalendarToolStore,
} from './google-calendar-tool.js';
const input = {
  projectId: 'p',
  sessionId: 's',
  turnId: 't',
  invocationId: 'i',
  request: { action: 'delete_event', calendarId: 'primary', eventId: 'e', expectedEtag: '"etag"' },
};
function setup(overrides: Partial<GoogleCalendarToolStore> = {}) {
  const store: GoogleCalendarToolStore = {
    getSession: vi.fn().mockResolvedValue({ projectId: 'p' }),
    getSessionCalendarConnection: vi
      .fn()
      .mockResolvedValue({ accountEmail: 'me@example.test', enabledAt: new Date() }),
    getVeritySettings: vi.fn().mockResolvedValue({
      calendarAuthorized: true,
      googleDriveRefreshToken: 'refresh',
      googleDriveAccountEmail: 'me@example.test',
    }),
    claimGoogleWorkspaceInvocation: vi.fn().mockResolvedValue({ status: 'claimed' }),
    completeGoogleWorkspaceInvocation: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const calendar = vi.fn().mockResolvedValue({ deleted: true });
  const tool = createGoogleCalendarTool({
    eventStore: store,
    calendar,
    googleAccessToken: async () => 'token',
  });
  return { store, calendar, tool };
}
describe('Google Calendar session tool', () => {
  it('requires approval for each mutation and allows only recognized reads', () => {
    expect(googleCalendarHasStandingAuthorization({ action: 'list_calendars' })).toBe(true);
    expect(googleCalendarHasStandingAuthorization(input.request)).toBe(false);
    expect(googleCalendarHasStandingAuthorization({ action: 'unknown' })).toBe(false);
  });
  it('blocks a disconnect racing token retrieval', async () => {
    const { tool, calendar } = setup({
      getSessionCalendarConnection: vi
        .fn()
        .mockResolvedValueOnce({ accountEmail: 'me@example.test' })
        .mockResolvedValueOnce(undefined),
    });
    await expect(tool.invoke(input)).rejects.toThrow('not enabled');
    expect(calendar).not.toHaveBeenCalled();
  });
  it('does not repeat completed or uncertain mutations', async () => {
    const completed = setup({
      claimGoogleWorkspaceInvocation: vi
        .fn()
        .mockResolvedValue({ status: 'completed', result: { deleted: true } }),
    });
    expect(await completed.tool.invoke(input)).toEqual({ deleted: true });
    expect(completed.calendar).not.toHaveBeenCalled();
    const pending = setup({
      claimGoogleWorkspaceInvocation: vi.fn().mockResolvedValue({ status: 'pending' }),
    });
    await expect(pending.tool.invoke(input)).rejects.toThrow('may already have happened');
    expect(pending.calendar).not.toHaveBeenCalled();
  });
  it('rejects calls from a different project before invoking Google', async () => {
    const { tool, calendar } = setup();
    await expect(tool.invoke({ ...input, projectId: 'other' })).rejects.toThrow('not enabled');
    expect(calendar).not.toHaveBeenCalled();
  });
});
