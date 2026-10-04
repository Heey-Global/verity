import { expect, it } from 'vitest';
import { promotionChangelog, type PromotionRelease } from './promotion-changelog.mjs';

function release(tag: string, prerelease = true, draft = false): PromotionRelease {
  return { tag_name: tag, body: `Notes for ${tag}`, prerelease, draft };
}

it.each(['server', 'mobile-native'] as const)(
  'collects staged %s versions after production and stops at the proposed candidate',
  (product) => {
    const prefix = product === 'server' ? 'v' : 'mobile-v';
    const notes = promotionChangelog(
      [
        release(`${prefix}2.10.0`),
        release(`${prefix}2.9.0`, false, true),
        release(`${prefix}2.8.0`),
        release(`${prefix}2.7.0`, false, true),
        release(`${prefix}2.6.0`, false),
        release(`${prefix}2.5.0`),
        release('website-v2.8.0'),
        release(product === 'server' ? 'mobile-v2.8.0' : 'v2.8.0'),
      ],
      product,
      '2.9.0',
    );
    expect(notes).toContain(`Changes since production ${prefix}2.6.0`);
    expect(notes).toContain(`Notes for ${prefix}2.9.0`);
    expect(notes).toContain(`Notes for ${prefix}2.8.0`);
    expect(notes).not.toContain('Notes for ' + prefix + '2.10.0');
    expect(notes).not.toContain('Notes for ' + prefix + '2.7.0');
    expect(notes).not.toContain('Notes for ' + prefix + '2.5.0');
    expect(notes).not.toContain('website-v');
    expect(notes.indexOf(`Notes for ${prefix}2.9.0`)).toBeLessThan(
      notes.indexOf(`Notes for ${prefix}2.8.0`),
    );
  },
);

it('uses delivered OTA patches as the native mobile production baseline', () => {
  const notes = promotionChangelog(
    [release('mobile-v1.50.4', false), release('mobile-v1.51.0', false, true)],
    'mobile-native',
    '1.51.0',
  );
  expect(notes).toContain('Changes since production mobile-v1.50.4');
});

it('covers the first release and refuses a missing candidate', () => {
  expect(promotionChangelog([release('v1.0.0', false, true)], 'server', '1.0.0')).toContain(
    'Notes for v1.0.0',
  );
  expect(() => promotionChangelog([], 'server', '1.0.0')).toThrow('notes are missing');
});
