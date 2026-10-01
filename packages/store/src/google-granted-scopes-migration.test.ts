import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { expect, it } from 'vitest';
import { migrationProvider } from './migrations.js';
import { createRawDb } from './testing.js';

it('preserves known legacy Workspace and service grants without granting Contacts', async () => {
  const ctx = createRawDb();
  try {
    const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
    expect((await migrator.migrateTo('0122_calendar_connections')).error).toBeUndefined();
    await sql`insert into verity_settings (id, google_drive_refresh_token, gmail_authorized, calendar_authorized)
      values ('global', 'legacy-refresh', true, true), ('unconnected', null, false, false)`.execute(
      ctx.db,
    );
    expect((await migrator.migrateToLatest()).error).toBeUndefined();
    const rows = await sql<{
      id: string;
      google_granted_scopes: string[];
      contacts_authorized: boolean;
    }>`select id, google_granted_scopes, contacts_authorized from verity_settings order by id`.execute(
      ctx.db,
    );
    const legacy = rows.rows.find((row) => row.id === 'global')!;
    for (const service of [
      'drive',
      'presentations',
      'documents',
      'spreadsheets',
      'gmail.readonly',
      'gmail.compose',
      'gmail.settings.basic',
      'calendar.calendarlist.readonly',
      'calendar.events',
    ]) {
      expect(legacy.google_granted_scopes).toContain(`https://www.googleapis.com/auth/${service}`);
    }
    expect(legacy.contacts_authorized).toBe(false);
    expect(legacy.google_granted_scopes).not.toContain(
      'https://www.googleapis.com/auth/contacts.readonly',
    );
    expect(rows.rows.find((row) => row.id === 'unconnected')).toMatchObject({
      google_granted_scopes: [],
      contacts_authorized: false,
    });
  } finally {
    await ctx.close();
  }
});
