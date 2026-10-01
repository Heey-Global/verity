/** Scopes required for session Calendar access on the shared Google credential. */
export function hasGoogleCalendarScopes(scopes: readonly string[] | undefined): boolean {
  return (
    scopes?.includes('https://www.googleapis.com/auth/calendar.calendarlist.readonly') === true &&
    scopes.includes('https://www.googleapis.com/auth/calendar.events')
  );
}
