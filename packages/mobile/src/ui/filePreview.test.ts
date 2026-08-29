import { describe, expect, it } from 'vitest';
import { chunkFilePreview } from './filePreview.js';

describe('chunkFilePreview', () => {
  it('returns no chunks for empty content so the caller can show an empty-file hint', () => {
    expect(chunkFilePreview('')).toEqual([]);
  });

  it('keeps a small file in a single chunk', () => {
    expect(chunkFilePreview('# Title\n\nbody')).toEqual(['# Title\n\nbody']);
  });

  it('breaks on line boundaries once the budget is exceeded', () => {
    expect(chunkFilePreview('aaa\nbbb\nccc\nddd', 8)).toEqual(['aaa\nbbb', 'ccc\nddd']);
  });

  it('round-trips the file when every line fits the budget', () => {
    const content = Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(i % 40)}`).join(
      '\n',
    );
    const chunks = chunkFilePreview(content, 300);
    expect(chunks.length).toBeGreaterThan(10);
    expect(chunks.join('\n')).toBe(content);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(300);
  });

  it('preserves blank lines and a trailing newline', () => {
    expect(chunkFilePreview('a\n\nb\n')).toEqual(['a\n\nb\n']);
  });

  it('keeps a line whole past the block budget rather than drawing a break mid-line', () => {
    expect(chunkFilePreview('x'.repeat(10), 4, 20)).toEqual(['x'.repeat(10)]);
  });

  it('gives an over-budget line its own block without merging the pending one', () => {
    expect(chunkFilePreview('ab\n' + 'x'.repeat(9), 4, 20)).toEqual(['ab', 'x'.repeat(9)]);
  });

  it('round-trips a file whose lines exceed the block budget but not the line budget', () => {
    const content = ['short', 'y'.repeat(5_000), '', 'tail'].join('\n');
    expect(chunkFilePreview(content, 100).join('\n')).toBe(content);
  });

  it('splits a line past the line budget, where a ragged wrap beats a blank preview', () => {
    expect(chunkFilePreview('x'.repeat(10), 4, 4)).toEqual(['xxxx', 'xxxx', 'xx']);
  });

  it('flushes the pending block before splitting a line past the line budget', () => {
    expect(chunkFilePreview('ab\n' + 'x'.repeat(9), 4, 4)).toEqual(['ab', 'xxxx', 'xxxx', 'x']);
  });

  it('bounds every block for a minified single-line file', () => {
    const chunks = chunkFilePreview('{"a":1}'.repeat(25_000)); // ~175 KB, one line
    expect(chunks.length).toBeGreaterThan(20);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(8_000);
  });

  it('never lets the line budget fall below the block budget', () => {
    expect(chunkFilePreview('x'.repeat(10), 4, 1)).toEqual(['xxxx', 'xxxx', 'xx']);
  });

  it('splits a large file into many bounded chunks', () => {
    const content = 'lorem ipsum dolor sit amet\n'.repeat(6_000); // ~160 KB
    const chunks = chunkFilePreview(content);
    expect(chunks.length).toBeGreaterThan(50);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2_000);
    expect(chunks.join('\n')).toBe(content);
  });

  it('degrades to one character per chunk on a non-positive budget rather than looping forever', () => {
    expect(chunkFilePreview('ab\ncd', 0, 0)).toEqual(['a', 'b', 'c', 'd']);
  });
});
