import { describe, expect, it } from 'vitest';
import { splitLines } from './lines.js';

async function collect(chunks: string[]): Promise<string[]> {
  async function* source(): AsyncGenerator<string> {
    for (const chunk of chunks) yield chunk;
  }
  const lines: string[] = [];
  for await (const line of splitLines(source())) lines.push(line);
  return lines;
}

describe('splitLines', () => {
  it('splits newline-delimited chunks', async () => {
    expect(await collect(['a\nb\n', 'c\n'])).toEqual(['a', 'b', 'c']);
  });

  it('reassembles a line split across chunk boundaries', async () => {
    expect(await collect(['{"t":', '"text"}\n'])).toEqual(['{"t":"text"}']);
  });

  it('yields a trailing line with no final newline', async () => {
    expect(await collect(['a\nb'])).toEqual(['a', 'b']);
  });

  it('yields empty lines between consecutive newlines', async () => {
    expect(await collect(['\n\n'])).toEqual(['', '']);
  });

  it('yields nothing for empty input', async () => {
    expect(await collect([])).toEqual([]);
    expect(await collect([''])).toEqual([]);
  });

  it('handles many single-character chunks', async () => {
    expect(await collect(['l', 'i', 'n', 'e', '\n', 'x'])).toEqual(['line', 'x']);
  });

  it('leaves the carriage return of CRLF on the line (parseLine trims it)', async () => {
    expect(await collect(['a\r\nb\r\n'])).toEqual(['a\r', 'b\r']);
  });
});
