import { describe, expect, it } from 'vitest';
import { splitSearchHighlights } from './searchHighlight.js';

describe('splitSearchHighlights', () => {
  it('highlights every term case-insensitively while preserving the original text', () => {
    const result = splitSearchHighlights('Search results make SEARCH useful.', 'search results');
    expect(result).toEqual([
      { text: 'Search', highlighted: true },
      { text: ' ', highlighted: false },
      { text: 'results', highlighted: true },
      { text: ' make ', highlighted: false },
      { text: 'SEARCH', highlighted: true },
      { text: ' useful.', highlighted: false },
    ]);
    expect(result.map((segment) => segment.text).join('')).toBe(
      'Search results make SEARCH useful.',
    );
  });

  it('ignores websearch operators and handles punctuation safely', () => {
    expect(splitSearchHighlights('foo.bar and baz', 'foo.bar OR baz')).toEqual([
      { text: 'foo', highlighted: true },
      { text: '.', highlighted: false },
      { text: 'bar', highlighted: true },
      { text: ' and ', highlighted: false },
      { text: 'baz', highlighted: true },
    ]);
  });

  it('returns one plain segment without a usable query', () => {
    expect(splitSearchHighlights('unchanged', 'OR')).toEqual([
      { text: 'unchanged', highlighted: false },
    ]);
  });
});
