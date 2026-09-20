import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { zipSync, strToU8 } from 'fflate';
import { processKnowledgeSource } from './knowledge-source-processing.js';

describe('original source processing', () => {
  it('retains unsupported bytes without claiming extraction', async () => {
    const bytes = Buffer.from('An opaque binary source');
    const result = await processKnowledgeSource('source.bin', bytes);
    expect(result.bytes).toEqual(bytes);
    expect(result.processingState).toBe('unsupported');
    expect(result.locators).toEqual([]);
  });
  it('renders an image preview and retains the exact original', async () => {
    const bytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#ff0000' },
    })
      .png()
      .toBuffer();
    const result = await processKnowledgeSource('logo.png', bytes);
    expect(result.bytes).toEqual(bytes);
    expect(result.processingState).toBe('ready');
    expect(result.previews[0]?.mediaType).toBe('image/png');
    expect(result.processingNote).toContain('No OCR');
  });
  it('does not process SVG external references or scripts', async () => {
    const bytes = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/private"/></svg>',
    );
    const result = await processKnowledgeSource('logo.svg', bytes);
    expect(result.bytes).toEqual(bytes);
    expect(result.processingState).toBe('unsupported');
    expect(result.previews).toEqual([]);
  });
  it('extracts presentation text with original slide part locators', async () => {
    const bytes = Buffer.from(
      zipSync({
        '[Content_Types].xml': strToU8('<Types/>'),
        'ppt/presentation.xml': strToU8('<p:presentation xmlns:p="p"/>'),
        'ppt/slides/slide2.xml': strToU8(
          '<p:sld xmlns:p="p" xmlns:a="a"><a:t>Project goals</a:t></p:sld>',
        ),
      }),
    );
    const result = await processKnowledgeSource('meeting.pptx', bytes);
    expect(result.processingState).toBe('ready');
    expect(result.locators).toEqual([{ label: 'Slide part 2', text: 'Project goals' }]);
    expect(result.processingNote).toContain('Layout');
  });
  it('rejects an archive bomb before allocating its expanded member', async () => {
    const bytes = Buffer.from(
      zipSync({
        '[Content_Types].xml': strToU8('<Types/>'),
        'word/document.xml': new Uint8Array(9 * 1024 * 1024),
      }),
    );
    const result = await processKnowledgeSource('bomb.docx', bytes);
    expect(result.processingState).toBe('failed');
    expect(result.bytes).toEqual(bytes);
    expect(result.locators).toEqual([]);
  });
});

it('extracts PDF text and renders the corresponding page for visual inspection', async () => {
  const stream = 'BT /F1 18 Tf 20 80 Td (Project values) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const result = await processKnowledgeSource('values.pdf', Buffer.from(pdf));
  expect(result.processingState, result.processingNote).toBe('ready');
  expect(result.locators).toEqual([{ label: 'Page 1', text: 'Project values' }]);
  expect(result.previews[0]?.label).toBe('Page 1');
  expect(result.previews[0]?.mediaType).toBe('image/png');
});

it('extracts Word paragraphs and spreadsheet rich strings with stable worksheet locators', async () => {
  const word = Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'word/document.xml': strToU8(
        '<w:document xmlns:w="w"><w:p><w:r><w:t>Meet</w:t></w:r><w:hyperlink><w:r><w:t>ing</w:t></w:r></w:hyperlink><w:r><w:t> &amp; decisions</w:t></w:r></w:p><w:p><w:r><w:t>Next paragraph</w:t></w:r></w:p></w:document>',
      ),
    }),
  );
  expect((await processKnowledgeSource('meeting.docx', word)).locators).toEqual([
    { label: 'Document', text: 'Meeting & decisions\nNext paragraph' },
  ]);
  const sheet = Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'xl/workbook.xml': strToU8('<workbook/>'),
      'xl/sharedStrings.xml': strToU8(
        '<sst><si><r><t>First </t></r><r><t>cell</t></r></si><si><t>Second</t></si></sst>',
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData></worksheet>',
      ),
    }),
  );
  const result = await processKnowledgeSource('values.xlsx', sheet);
  expect(result.processingState).toBe('ready');
  expect(result.locators).toEqual([
    { label: 'xl/worksheets/sheet1.xml', text: 'A1: First cell\nB1: Second' },
  ]);
});
