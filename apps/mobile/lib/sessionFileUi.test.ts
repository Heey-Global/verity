import { pdfFileName } from './sessionFileUi';

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
