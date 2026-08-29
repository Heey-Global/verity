/**
 * GitHub-flavored markdown table parsing (pure → unit-testable). Agent prose can
 * contain tables (a header row, a `|---|` separator, then body rows); rendered
 * raw they'd show their pipes. {@link parseMarkdownBlocks} splits a prose block
 * into `table` blocks (parsed grid) and `lines` blocks (everything else) so the
 * screen renders tables as an aligned grid and the rest as plain markdown lines.
 * Block-level because a table spans several lines. Kept out of the React screen
 * so the detection/splitting rules are tested without rendering.
 *
 * NOTE: callers must run this on PROSE only — fenced code is isolated first (see
 * {@link splitRichText}), so a `| … |` line inside a code block is never here.
 */
export type MdBlock =
  { type: 'lines'; lines: string[] } | { type: 'table'; header: string[]; rows: string[][] };

// A row is any `| … |` line; the separator is the `|---|` divider under the
// header (cells of only dashes/colons/spaces). A header line matches TABLE_ROW
// but NOT TABLE_SEP.
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_SEP = /^\s*\|[\s:|-]*-[\s:|-]*\|\s*$/;

/** Split a `| a | b | c |` line into trimmed cell strings, dropping the leading
 * and trailing pipes. */
export function splitTableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** Split prose into table blocks and plain-line blocks, preserving order. A
 * table starts where a header row is immediately followed by a `|---|` separator;
 * its body runs until the first non-row (or another separator). */
export function parseMarkdownBlocks(content: string): MdBlock[] {
  const lines = content.split('\n');
  const blocks: MdBlock[] = [];
  let buf: string[] = [];
  const flush = (): void => {
    if (buf.length > 0) {
      blocks.push({ type: 'lines', lines: buf });
      buf = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const next = lines[i + 1] ?? '';
    // A header row immediately followed by a `|---|` separator starts a table.
    if (TABLE_ROW.test(line) && !TABLE_SEP.test(line) && TABLE_SEP.test(next)) {
      flush();
      const header = splitTableCells(line);
      const rows: string[][] = [];
      i += 2; // consume header + separator
      // Body runs until the first non-row line. Two tables therefore need an
      // intervening non-row line to split (GFM requires a blank line between
      // them); back-to-back tables with no gap would fold into one.
      while (
        i < lines.length &&
        TABLE_ROW.test(lines[i] ?? '') &&
        !TABLE_SEP.test(lines[i] ?? '')
      ) {
        rows.push(splitTableCells(lines[i] ?? ''));
        i++;
      }
      i--; // the for-loop re-increments
      blocks.push({ type: 'table', header, rows });
    } else {
      buf.push(line);
    }
  }
  flush();
  return blocks;
}
