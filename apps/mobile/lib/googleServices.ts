// Pure service/scope catalogue shared by the Google login, settings, and session access.
export const googleScope = (name: string) => `https://www.googleapis.com/auth/${name}`;

/**
 * Every Google service Verity offers, requested together in one consent. Google lets the
 * user deselect individual permissions there; the account keeps whatever was granted and
 * settings list the services that are still missing.
 */
export const GOOGLE_SERVICES = [
  // A linked folder is a read/write project workspace. Google does not grant folder-wide
  // access to existing children through `drive.file`, so request the Drive scope and
  // enforce the selected folder at Verity's project boundary.
  { name: 'Drive', scopes: [googleScope('drive')] },
  {
    name: 'Gmail',
    scopes: ['gmail.readonly', 'gmail.compose', 'gmail.settings.basic'].map(googleScope),
  },
  {
    name: 'Calendar',
    scopes: ['calendar.calendarlist.readonly', 'calendar.events'].map(googleScope),
  },
  { name: 'Contacts', scopes: [googleScope('contacts.readonly')] },
  {
    name: 'Docs, Sheets & Slides',
    scopes: ['documents', 'spreadsheets', 'presentations'].map(googleScope),
  },
] as const;

export type GoogleServiceName = (typeof GOOGLE_SERVICES)[number]['name'];

/** The services an account has not (fully) granted, in display order. */
export function missingGoogleServices(scopes: readonly string[]): GoogleServiceName[] {
  return GOOGLE_SERVICES.filter((service) =>
    service.scopes.some((required) => !scopes.includes(required)),
  ).map((service) => service.name);
}
