import { acceptWebDrop, DEFAULT_MAX_DROPPED_FILE_BYTES } from './webDrop';

function item(name: string, size: number, type = 'text/plain', isDirectory = false) {
  return { file: { name, size, type } as File, isDirectory };
}

const url = (file: File) => `blob:${file.name}`;

// A browser drop bypasses the native target's checks, so without these limits a
// folder or an oversized file would only fail later, after being read into memory.
describe('acceptWebDrop', () => {
  it('passes accepted files on as object URLs with their names and types', () => {
    expect(acceptWebDrop([item('a.txt', 3), item('b.bin', 4, '')], { maxFiles: 5 }, url)).toEqual({
      files: [
        { uri: 'blob:a.txt', fileName: 'a.txt', mediaType: 'text/plain' },
        { uri: 'blob:b.bin', fileName: 'b.bin', mediaType: 'application/octet-stream' },
      ],
      errors: [],
    });
  });

  it('refuses folders and files beyond the remaining slots', () => {
    const result = acceptWebDrop(
      [item('dir', 0, '', true), item('a', 1), item('b', 1)],
      { maxFiles: 1 },
      url,
    );
    expect(result.files.map((file) => file.fileName)).toEqual(['a']);
    expect(result.errors).toEqual([
      'Only 1 more file can be added.',
      'Folders and some file types are not supported.',
    ]);
  });

  it('applies the composer cap unless a surface raises the per-file limit', () => {
    const big = item('big.pdf', DEFAULT_MAX_DROPPED_FILE_BYTES + 1);
    expect(acceptWebDrop([big], { maxFiles: 1 }, url).files).toEqual([]);
    expect(acceptWebDrop([big], { maxFiles: 1, maxFileBytes: 50_000_000 }, url).files).toHaveLength(
      1,
    );
  });

  it('skips files once the drop exceeds its total budget', () => {
    const result = acceptWebDrop(
      [item('a', 6), item('b', 6)],
      { maxFiles: 2, maxFileBytes: 10, maxTotalBytes: 10 },
      url,
    );
    expect(result.files.map((file) => file.fileName)).toEqual(['a']);
    expect(result.errors).toEqual(['"b" was skipped (max ~0 MB per drop).']);
  });
});
