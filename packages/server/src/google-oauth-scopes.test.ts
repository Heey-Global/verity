import { describe, expect, it } from 'vitest';
import {
  hasGoogleCalendarScopes,
  hasGoogleContactsScopes,
  hasGoogleDriveScopes,
  hasGoogleGmailScopes,
  hasGoogleWorkspaceScope,
} from './google-oauth-scopes.js';

const prefix = 'https://www.googleapis.com/auth/';
const services = [
  { name: 'Drive', check: hasGoogleDriveScopes, scopes: ['drive'] },
  { name: 'Contacts', check: hasGoogleContactsScopes, scopes: ['contacts.readonly'] },
  {
    name: 'Gmail',
    check: hasGoogleGmailScopes,
    scopes: ['gmail.readonly', 'gmail.compose', 'gmail.settings.basic'],
  },
  {
    name: 'Calendar',
    check: hasGoogleCalendarScopes,
    scopes: ['calendar.calendarlist.readonly', 'calendar.events'],
  },
  ...(['docs', 'sheets', 'slides'] as const).map((kind, index) => ({
    name: kind,
    check: (scopes: readonly string[] | undefined) => hasGoogleWorkspaceScope(scopes, kind),
    scopes: [['documents'], ['spreadsheets'], ['presentations']][index]!,
  })),
];

describe.each(services)('$name scope authorization', ({ check, scopes }) => {
  const required = scopes.map((scope) => prefix + scope);
  it('accepts complete exact grants and rejects missing grants', () => {
    expect(check(required)).toBe(true);
    expect(check(undefined)).toBe(false);
    for (let index = 0; index < required.length; index++) {
      expect(check(required.filter((_, position) => position !== index))).toBe(false);
    }
  });
  // A lookalike scope must never enable a service or an editor.
  it('rejects grants containing a required scope only as a substring', () => {
    for (let index = 0; index < required.length; index++) {
      for (const spoof of [
        'https://attacker.example/' + required[index],
        required[index] + '.attacker.example',
        required[index] + '/extra',
      ]) {
        const grants = [...required];
        grants[index] = spoof;
        expect(check(grants)).toBe(false);
      }
    }
  });
});
