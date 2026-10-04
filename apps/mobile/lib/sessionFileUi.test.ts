import { breadcrumbSegments, pdfFileName, renameProblem } from './sessionFileUi';

describe('pdfFileName', () => {
  // The share sheet shows this name; a doubled or missing extension reads as a
  // broken export in the receiving app.
  it('replaces the extension of the file name with .pdf', () => {
    expect(pdfFileName('notes/2026-09-30-eo-5-reflection.md')).toBe(
      '2026-09-30-eo-5-reflection.pdf',
    );
    expect(pdfFileName('README')).toBe('README.pdf');
    expect(pdfFileName('.env')).toBe('.env.pdf');
  });
});

describe('breadcrumbSegments', () => {
  it('gives every folder the path a tap on it opens', () => {
    expect(breadcrumbSegments('insights/verity-uplink/core')).toEqual([
      { name: 'insights', path: 'insights' },
      { name: 'verity-uplink', path: 'insights/verity-uplink' },
      { name: 'core', path: 'insights/verity-uplink/core' },
    ]);
  });

  it('has no segments at the root', () => {
    expect(breadcrumbSegments('')).toEqual([]);
  });
});

describe('renameProblem', () => {
  const siblings = ['a.md', 'b.md'];

  it('accepts a free name and the unchanged one', () => {
    expect(renameProblem('c.md', 'a.md', siblings)).toBeNull();
    expect(renameProblem('a.md', 'a.md', siblings)).toBeNull();
  });

  it('refuses a name another file in the folder already has', () => {
    // The server would answer 409; saying so in the dialog keeps the name editable.
    expect(renameProblem('b.md', 'a.md', siblings)).toBe('"b.md" already exists here.');
  });

  it('refuses names the server rejects', () => {
    for (const name of ['', '   ', '.', '..', 'x/y.md', 'x\\y.md', ' a.md', 'é'.repeat(128)]) {
      expect(renameProblem(name, 'a.md', siblings)).not.toBeNull();
    }
  });
});
