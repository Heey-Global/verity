import { describe, expect, it } from 'vitest';

import { spellOutBidiControls } from './bidi.js';

describe('spellOutBidiControls', () => {
  it('names each control where it sat, without dropping anything else', () => {
    expect(spellOutBidiControls('Delete\u202e nothing\u202c, then stop')).toBe(
      'Delete<U+202E> nothing<U+202C>, then stop',
    );
    // Every member of the class, so a range typo in the regex is caught rather than assumed.
    const all = '\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069';
    expect(spellOutBidiControls(all)).toBe(
      '<U+061C><U+200E><U+200F><U+202A><U+202B><U+202C><U+202D><U+202E>' +
        '<U+2066><U+2067><U+2068><U+2069>',
    );
  });

  it('leaves the characters ordinary words are spelled with alone', () => {
    // ZWNJ in Persian, ZWJ in an emoji sequence, a soft hyphen, and plain formatting. Filtering
    // these would corrupt correct text while catching nothing that reorders it.
    const text =
      'mi\u200crawad \ud83d\udc69\u200d\ud83d\udcbb soft\u00adhyphen\n\tindented \u2014 dash';
    expect(spellOutBidiControls(text)).toBe(text);
  });

  it('annotates the raw-JSON card fallback, which JSON.stringify does not escape', () => {
    // The path this exists for: a bidi control in a headline field is one of the reasons a
    // summary returns null, so the input likeliest to reorder the card is the one rendered as
    // raw JSON. `JSON.stringify` escapes quotes, backslashes and C0 controls — not these.
    const raw = JSON.stringify({ title: 'a\u202eb' });
    expect(raw).toContain('\u202e');
    expect(spellOutBidiControls(raw)).toBe('{"title":"a<U+202E>b"}');
  });
});
