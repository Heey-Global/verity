import { chunkFilePreview, parseMarkdownBlocks, splitRichText } from '@verity/mobile';

export type FileMarkdownItem =
  | { type: 'line'; content: string }
  | { type: 'code'; content: string; lang: string | null }
  | { type: 'table'; header: string[]; rows: string[][] };

export function isMarkdownFile(path: string): boolean {
  return /\.(md|markdown|mdown)$/i.test(path);
}

/** Parse before chunking so fences and table separators keep their meaning.
 * Bound every native text node and table group: a large file must not become
 * one native layout pass that silently draws blank on iOS. */
export function fileMarkdownItems(content: string): FileMarkdownItem[] {
  const items: FileMarkdownItem[] = [];
  const text = (type: 'line' | 'code', content: string, lang: string | null = null) => {
    if (content === '') {
      items.push({ type: 'line', content: '' });
      return;
    }
    for (const chunk of chunkFilePreview(content)) {
      items.push(type === 'code' ? { type, content: chunk, lang } : { type, content: chunk });
    }
  };
  for (const block of splitRichText(content)) {
    if (block.type === 'code') {
      text('code', block.content, block.lang);
      continue;
    }
    for (const prose of parseMarkdownBlocks(block.content)) {
      if (prose.type === 'lines') {
        for (const line of prose.lines) text('line', line);
      } else {
        // Oversized cells use bounded text rather than one unrenderable table.
        if ([prose.header, ...prose.rows].some((row) => row.join('').length > 8000)) {
          text('code', [prose.header, ...prose.rows].map((row) => row.join(' | ')).join('\n'));
          continue;
        }
        let rows: string[][] = [];
        let chars = 0;
        for (const row of prose.rows) {
          const size = row.join('').length;
          if (rows.length && (rows.length >= 20 || chars + size > 8000)) {
            items.push({ type: 'table', header: prose.header, rows });
            rows = [];
            chars = 0;
          }
          rows.push(row);
          chars += size;
        }
        items.push({ type: 'table', header: prose.header, rows });
      }
    }
  }
  return items;
}
