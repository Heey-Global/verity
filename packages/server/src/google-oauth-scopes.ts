/** Gmail requires reading, draft composition, and the configured sending signature. */
export function hasGoogleGmailScopes(scopes: readonly string[] | undefined): boolean {
  return ['gmail.readonly', 'gmail.compose', 'gmail.settings.basic'].every((scope) =>
    scopes?.some((granted) => granted === `https://www.googleapis.com/auth/${scope}`),
  );
}
/** Calendar discovery and event editing do not authorize Drive or Gmail. */
export function hasGoogleCalendarScopes(scopes: readonly string[] | undefined): boolean {
  return ['calendar.calendarlist.readonly', 'calendar.events'].every((scope) =>
    scopes?.some((granted) => granted === `https://www.googleapis.com/auth/${scope}`),
  );
}
/** Contacts lookup never requires permission to edit contacts. */
export function hasGoogleContactsScopes(scopes: readonly string[] | undefined): boolean {
  return (
    scopes?.some((granted) => granted === 'https://www.googleapis.com/auth/contacts.readonly') ===
    true
  );
}
export function hasGoogleDriveScopes(scopes: readonly string[] | undefined): boolean {
  return scopes?.some((granted) => granted === 'https://www.googleapis.com/auth/drive') === true;
}
/** Native file editors require their own consent in addition to Drive browsing. */
export function hasGoogleWorkspaceScope(
  scopes: readonly string[] | undefined,
  kind: 'docs' | 'sheets' | 'slides',
): boolean {
  const scope =
    kind === 'docs' ? 'documents' : kind === 'sheets' ? 'spreadsheets' : 'presentations';
  return scopes?.some((granted) => granted === `https://www.googleapis.com/auth/${scope}`) === true;
}
