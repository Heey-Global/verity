export interface SearchHighlightSegment {
  text: string;
  highlighted: boolean;
}

const SEARCH_TERM = /[\p{L}\p{N}_-]+/gu;
const WEBSEARCH_OPERATORS = new Set(['and', 'or', 'not']);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Split display text into case-insensitive matches for the meaningful terms in a
 * web-search query. Keeping this pure makes user bubbles, markdown spans, links,
 * and code blocks share identical highlighting behavior. */
export function splitSearchHighlights(
  text: string,
  query: string | null,
): SearchHighlightSegment[] {
  if (!query?.trim() || !text) return [{ text, highlighted: false }];
  const terms = [...query.matchAll(SEARCH_TERM)]
    .map((match) => match[0])
    .filter((term) => !WEBSEARCH_OPERATORS.has(term.toLowerCase()));
  const unique = [...new Set(terms.map((term) => term.toLocaleLowerCase()))].sort(
    (a, b) => b.length - a.length,
  );
  if (unique.length === 0) return [{ text, highlighted: false }];

  const matcher = new RegExp(`(${unique.map(escapeRegExp).join('|')})`, 'giu');
  const result: SearchHighlightSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(matcher)) {
    const index = match.index;
    if (index > last) result.push({ text: text.slice(last, index), highlighted: false });
    result.push({ text: match[0], highlighted: true });
    last = index + match[0].length;
  }
  if (last < text.length) result.push({ text: text.slice(last), highlighted: false });
  return result.length > 0 ? result : [{ text, highlighted: false }];
}
