import { describe, expect, it } from 'vitest';
import { parseMarkdownBlocks, splitTableCells } from './markdownTable.js';

describe('splitTableCells', () => {
  it('splits a piped row into trimmed cells, dropping leading/trailing pipes', () => {
    expect(splitTableCells('| a | b | c |')).toEqual(['a', 'b', 'c']);
  });

  it('keeps interior empty cells', () => {
    expect(splitTableCells('| a |  | c |')).toEqual(['a', '', 'c']);
  });

  it('handles a row without outer pipes', () => {
    expect(splitTableCells('a | b')).toEqual(['a', 'b']);
  });
});

describe('parseMarkdownBlocks', () => {
  it('returns a single lines block for prose with no table', () => {
    expect(parseMarkdownBlocks('hello\nworld')).toEqual([
      { type: 'lines', lines: ['hello', 'world'] },
    ]);
  });

  it('parses a header + separator + body into a table block', () => {
    const blocks = parseMarkdownBlocks('| H1 | H2 |\n| --- | --- |\n| a | b |\n| c | d |');
    expect(blocks).toEqual([
      {
        type: 'table',
        header: ['H1', 'H2'],
        rows: [
          ['a', 'b'],
          ['c', 'd'],
        ],
      },
    ]);
  });

  it('keeps prose before and after a table as separate lines blocks', () => {
    const blocks = parseMarkdownBlocks('intro\n| H |\n| - |\n| x |\noutro');
    expect(blocks.map((b) => b.type)).toEqual(['lines', 'table', 'lines']);
    expect(blocks[0]).toEqual({ type: 'lines', lines: ['intro'] });
    expect(blocks[2]).toEqual({ type: 'lines', lines: ['outro'] });
  });

  it('does NOT treat a piped row as a table without a following separator', () => {
    const blocks = parseMarkdownBlocks('| not | a | table |\njust pipes');
    expect(blocks).toEqual([{ type: 'lines', lines: ['| not | a | table |', 'just pipes'] }]);
  });

  it('tolerates a header-only table (separator but zero body rows)', () => {
    const blocks = parseMarkdownBlocks('| H1 | H2 |\n| --- | --- |');
    expect(blocks).toEqual([{ type: 'table', header: ['H1', 'H2'], rows: [] }]);
  });

  it('keeps ragged body rows verbatim (no padding or truncation)', () => {
    const blocks = parseMarkdownBlocks('| a | b | c |\n| - | - | - |\n| 1 |');
    expect(blocks).toEqual([{ type: 'table', header: ['a', 'b', 'c'], rows: [['1']] }]);
  });

  it('parses a second table after intervening prose', () => {
    const blocks = parseMarkdownBlocks('| A |\n| - |\n| 1 |\nmid\n| B |\n| - |\n| 2 |');
    expect(blocks.map((b) => b.type)).toEqual(['table', 'lines', 'table']);
  });

  it('splits two tables separated by a blank line (the GFM-valid form)', () => {
    const blocks = parseMarkdownBlocks('| A |\n| - |\n| 1 |\n\n| B |\n| - |\n| 2 |');
    expect(blocks.map((b) => b.type)).toEqual(['table', 'lines', 'table']);
    expect(blocks[1]).toEqual({ type: 'lines', lines: [''] });
  });
});
