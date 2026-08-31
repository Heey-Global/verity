import type { SessionFileEntry } from '@verity/mobile';

import {
  MAX_DOWNLOADABLE_FILE_BYTES,
  dragItemsForRow,
  fileNameFromPath,
  isSelectableFile,
  mimeTypeForFile,
  retainVisibleSelection,
  selectionForModifierClick,
  selectionSummary,
  toggleFileSelection,
} from './fileSelection';

function entry(
  path: string,
  kind: SessionFileEntry['kind'] = 'file',
  size: number | null = kind === 'file' ? 12 : null,
): SessionFileEntry {
  return {
    name: path.split('/').pop() ?? path,
    path,
    kind,
    size,
    modifiedAt: null,
  };
}

const downloadUrl = (path: string) => `https://verity.test/files?path=${encodeURIComponent(path)}`;

describe('fileNameFromPath', () => {
  it('takes the last segment and ignores trailing slashes', () => {
    expect(fileNameFromPath('src/ui/report.pdf')).toBe('report.pdf');
    expect(fileNameFromPath('docs/')).toBe('docs');
  });

  it('falls back to a name a drop destination can still save', () => {
    expect(fileNameFromPath('')).toBe('download');
  });
});

describe('mimeTypeForFile', () => {
  it('maps known extensions case-insensitively', () => {
    expect(mimeTypeForFile('a/B.PNG')).toBe('image/png');
    expect(mimeTypeForFile('report.pdf')).toBe('application/pdf');
    expect(mimeTypeForFile('notes.md')).toBe('text/plain');
  });

  it('falls back to octet-stream for unknown types', () => {
    expect(mimeTypeForFile('build/app.bin')).toBe('application/octet-stream');
  });
});

describe('isSelectableFile', () => {
  it('accepts only regular files', () => {
    expect(isSelectableFile(entry('a.txt'))).toBe(true);
    expect(isSelectableFile(entry('src', 'directory'))).toBe(false);
    expect(isSelectableFile(entry('link', 'symlink'))).toBe(false);
    expect(isSelectableFile(entry('sock', 'other'))).toBe(false);
  });

  it('rejects files the download endpoint would refuse, and allows the cap itself', () => {
    expect(isSelectableFile(entry('big.bin', 'file', MAX_DOWNLOADABLE_FILE_BYTES))).toBe(true);
    expect(isSelectableFile(entry('big.bin', 'file', MAX_DOWNLOADABLE_FILE_BYTES + 1))).toBe(false);
  });

  it('treats an unknown size as downloadable and lets the server decide', () => {
    expect(isSelectableFile(entry('unknown.bin', 'file', null))).toBe(true);
  });
});

describe('toggleFileSelection', () => {
  it('adds a missing path and removes a present one', () => {
    expect(toggleFileSelection([], 'a.txt')).toEqual(['a.txt']);
    expect(toggleFileSelection(['a.txt', 'b.txt'], 'a.txt')).toEqual(['b.txt']);
  });

  it('does not mutate the input', () => {
    const selected = ['a.txt'];
    toggleFileSelection(selected, 'b.txt');
    expect(selected).toEqual(['a.txt']);
  });
});

describe('retainVisibleSelection', () => {
  it('drops paths that left the listing', () => {
    const entries = [entry('a.txt'), entry('b.txt')];
    expect(retainVisibleSelection(['a.txt', 'gone.txt'], entries)).toEqual(['a.txt']);
  });

  it('drops a path whose entry is no longer a regular file', () => {
    expect(retainVisibleSelection(['a.txt'], [entry('a.txt', 'symlink')])).toEqual([]);
  });
});

describe('dragItemsForRow', () => {
  const entries = [entry('src', 'directory'), entry('a.txt'), entry('b.png'), entry('c.pdf')];

  it('drags the whole selection when the grabbed row is part of it', () => {
    const items = dragItemsForRow(entry('a.txt'), ['c.pdf', 'a.txt'], entries, downloadUrl);
    expect(items.map((item) => item.fileName)).toEqual(['a.txt', 'c.pdf']);
    expect(items[0]).toEqual({
      url: downloadUrl('a.txt'),
      fileName: 'a.txt',
      mimeType: 'text/plain',
    });
  });

  it('orders items by the listing, not by the order rows were tapped', () => {
    const items = dragItemsForRow(
      entry('c.pdf'),
      ['c.pdf', 'b.png', 'a.txt'],
      entries,
      downloadUrl,
    );
    expect(items.map((item) => item.fileName)).toEqual(['a.txt', 'b.png', 'c.pdf']);
  });

  it('drags only the grabbed row when it sits outside the selection', () => {
    const items = dragItemsForRow(entry('b.png'), ['a.txt'], entries, downloadUrl);
    expect(items.map((item) => item.fileName)).toEqual(['b.png']);
    expect(items[0]?.mimeType).toBe('image/png');
  });

  it('never drags a stale selection entry that has left the listing', () => {
    const items = dragItemsForRow(entry('a.txt'), ['a.txt', 'gone.txt'], entries, downloadUrl);
    expect(items.map((item) => item.fileName)).toEqual(['a.txt']);
  });

  it('refuses to drag anything that is not a regular file', () => {
    expect(dragItemsForRow(entry('src', 'directory'), [], entries, downloadUrl)).toEqual([]);
  });

  it('refuses to drag a file the download endpoint would refuse', () => {
    const big = entry('big.bin', 'file', MAX_DOWNLOADABLE_FILE_BYTES + 1);
    expect(dragItemsForRow(big, [], [...entries, big], downloadUrl)).toEqual([]);
  });
});

describe('selectionForModifierClick', () => {
  const entries = [
    entry('src', 'directory'),
    entry('a.txt'),
    entry('b.png'),
    entry('c.pdf'),
    entry('d.md'),
  ];
  const none = { shift: false, command: false };
  const command = { shift: false, command: true };
  const shift = { shift: true, command: false };
  const empty = { selected: [], anchor: null, range: [] };

  it('leaves a plain click to the caller', () => {
    expect(selectionForModifierClick(empty, entry('a.txt'), none, entries)).toBeNull();
  });

  it('leaves a click on an unselectable row to the caller, modifier or not', () => {
    const directory = entry('src', 'directory');
    expect(selectionForModifierClick(empty, directory, command, entries)).toBeNull();
    const big = entry('big.bin', 'file', MAX_DOWNLOADABLE_FILE_BYTES + 1);
    expect(selectionForModifierClick(empty, big, shift, [...entries, big])).toBeNull();
  });

  it('command-clicks one row at a time, both ways, and moves the anchor', () => {
    const first = selectionForModifierClick(empty, entry('b.png'), command, entries);
    expect(first).toEqual({ selected: ['b.png'], anchor: 'b.png', range: [] });
    const second = selectionForModifierClick(
      { selected: ['b.png'], anchor: 'b.png', range: [] },
      entry('b.png'),
      command,
      entries,
    );
    expect(second).toEqual({ selected: [], anchor: 'b.png', range: [] });
  });

  it('shift-clicks the range between the anchor and the row, in either direction', () => {
    const down = selectionForModifierClick(
      { selected: ['a.txt'], anchor: 'a.txt', range: [] },
      entry('c.pdf'),
      shift,
      entries,
    );
    expect(down).toEqual({
      selected: ['a.txt', 'b.png', 'c.pdf'],
      anchor: 'a.txt',
      range: ['b.png', 'c.pdf'],
    });
    const up = selectionForModifierClick(
      { selected: ['c.pdf'], anchor: 'c.pdf', range: [] },
      entry('a.txt'),
      shift,
      entries,
    );
    expect(up).toEqual({
      selected: ['c.pdf', 'a.txt', 'b.png'],
      anchor: 'c.pdf',
      range: ['a.txt', 'b.png'],
    });
  });

  it('resizes the range on a second shift-click instead of only growing it', () => {
    const wide = selectionForModifierClick(
      { selected: ['a.txt'], anchor: 'a.txt', range: [] },
      entry('d.md'),
      shift,
      entries,
    );
    expect(wide?.selected).toEqual(['a.txt', 'b.png', 'c.pdf', 'd.md']);
    const narrower = selectionForModifierClick(
      { selected: wide?.selected ?? [], anchor: wide?.anchor ?? null, range: wide?.range ?? [] },
      entry('b.png'),
      shift,
      entries,
    );
    expect(narrower).toEqual({
      selected: ['a.txt', 'b.png'],
      anchor: 'a.txt',
      range: ['b.png'],
    });
  });

  it('hands the range over to the operator once a command-click intervenes', () => {
    const wide = selectionForModifierClick(
      { selected: ['a.txt'], anchor: 'a.txt', range: [] },
      entry('d.md'),
      shift,
      entries,
    );
    // Command-clicking drops d.md and ends the range's claim on the rest, so the
    // rows it put there are now the operator's own and survive a later shrink.
    const pinned = selectionForModifierClick(
      { selected: wide?.selected ?? [], anchor: wide?.anchor ?? null, range: wide?.range ?? [] },
      entry('d.md'),
      command,
      entries,
    );
    expect(pinned).toEqual({
      selected: ['a.txt', 'b.png', 'c.pdf'],
      anchor: 'd.md',
      range: [],
    });
    const shrunk = selectionForModifierClick(
      {
        selected: pinned?.selected ?? [],
        anchor: 'a.txt',
        range: pinned?.range ?? [],
      },
      entry('b.png'),
      shift,
      entries,
    );
    expect(shrunk?.selected).toEqual(['a.txt', 'b.png', 'c.pdf']);
  });

  it('skips rows in the range that cannot be selected', () => {
    const spanning = selectionForModifierClick(
      { selected: [], anchor: 'src', range: [] },
      entry('b.png'),
      shift,
      entries,
    );
    expect(spanning).toEqual({
      selected: ['a.txt', 'b.png'],
      anchor: 'src',
      range: ['a.txt', 'b.png'],
    });
  });

  it('keeps a selection built by command-clicks when a range is added', () => {
    const merged = selectionForModifierClick(
      { selected: ['d.md'], anchor: 'a.txt', range: [] },
      entry('b.png'),
      shift,
      entries,
    );
    expect(merged?.selected).toEqual(['d.md', 'a.txt', 'b.png']);
    expect(merged?.range).toEqual(['a.txt', 'b.png']);
  });

  it('treats a shift-click with no live anchor as a single row', () => {
    const orphaned = selectionForModifierClick(
      { selected: [], anchor: 'gone.txt', range: [] },
      entry('c.pdf'),
      shift,
      entries,
    );
    expect(orphaned).toEqual({ selected: ['c.pdf'], anchor: 'c.pdf', range: ['c.pdf'] });
  });

  it('leaves a shift-click on a row that is not in the listing to the caller', () => {
    expect(
      selectionForModifierClick(
        { selected: [], anchor: 'a.txt', range: [] },
        entry('gone.txt'),
        shift,
        entries,
      ),
    ).toBeNull();
  });

  it('lets shift win when both modifiers are held', () => {
    const both = selectionForModifierClick(
      { selected: ['a.txt'], anchor: 'a.txt', range: [] },
      entry('b.png'),
      { shift: true, command: true },
      entries,
    );
    expect(both).toEqual({ selected: ['a.txt', 'b.png'], anchor: 'a.txt', range: ['b.png'] });
  });

  it('does not mutate the selection it was given', () => {
    const selected = ['a.txt'];
    selectionForModifierClick(
      { selected, anchor: 'a.txt', range: [] },
      entry('d.md'),
      shift,
      entries,
    );
    expect(selected).toEqual(['a.txt']);
  });
});

describe('selectionSummary', () => {
  it('reads naturally for one and for many', () => {
    expect(selectionSummary(1)).toBe('1 selected');
    expect(selectionSummary(3)).toBe('3 selected');
  });
});
