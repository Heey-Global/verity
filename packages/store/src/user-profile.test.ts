import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, truncateAll, type TestDb } from './testing.js';
import { normalizeDisplayName } from './user-profile.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.db
    .insertInto('users')
    .values([
      { id: 'admin', role: 'administrator', status: 'active' },
      { id: 'member', role: 'member', status: 'active' },
    ])
    .execute();
});

describe('user display names', () => {
  it('normalizes one visible line and rejects names that could forge layout', () => {
    expect(normalizeDisplayName('  Lena   Schmidt ')).toBe('Lena Schmidt');
    // Line breaks and separators collapse to a space like any other whitespace run.
    expect(normalizeDisplayName('Holger\nTeske')).toBe('Holger Teske');
    expect(normalizeDisplayName('Holger\u2028Teske')).toBe('Holger Teske');
    expect(normalizeDisplayName('Ä'.repeat(80))).toHaveLength(80);
    expect(() => normalizeDisplayName('   ')).toThrow(RangeError);
    expect(() => normalizeDisplayName('x'.repeat(81))).toThrow(RangeError);
    // Invisible formatting and control characters would let a name reorder or
    // hide parts of the line it is shown in.
    expect(() => normalizeDisplayName('Holger\u202EekseT')).toThrow(RangeError);
    expect(() => normalizeDisplayName('Holger\u0000')).toThrow(RangeError);
  });

  it('stores the name on the person, not on a device', async () => {
    const profiles = ctx.store.userProfiles;
    await expect(profiles.read('member')).resolves.toEqual({
      userId: 'member',
      role: 'member',
      displayName: null,
    });
    await profiles.setDisplayName('member', ' Lena ');
    await expect(profiles.displayNames(['member', 'member', 'admin', 'missing'])).resolves.toEqual(
      new Map([
        ['member', 'Lena'],
        ['admin', null],
      ]),
    );
    await expect(profiles.setDisplayName('missing', 'Lena')).rejects.toThrow('User not found');
    await expect(profiles.read('missing')).resolves.toBeUndefined();
  });

  // The column check is the last line of defence for writers that bypass the store.
  it('rejects a blank name in the database itself', async () => {
    await expect(
      ctx.db.updateTable('users').set({ display_name: '   ' }).where('id', '=', 'member').execute(),
    ).rejects.toThrow();
  });
});
