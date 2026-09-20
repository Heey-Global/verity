import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import sharp from 'sharp';
import type { KnowledgeSourceInput } from '@verity/store';

type Output = Omit<KnowledgeSourceInput, 'bytes' | 'filename'>;
const filename = process.argv[2] ?? '';
const chunks: Buffer[] = [];
for await (const chunk of process.stdin as AsyncIterable<Uint8Array>)
  chunks.push(Buffer.from(chunk));
const bytes = Buffer.concat(chunks);
const extension = filename.toLowerCase().split('.').pop();
const output: Output = {
  mediaType: 'application/octet-stream',
  processingState: 'unsupported',
  processingNote: 'Original retained. This format cannot be processed.',
  locators: [],
  previews: [],
};
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  processEntities: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: false,
});
const orderedXmlParser = new XMLParser({
  ignoreAttributes: false,
  processEntities: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: false,
  preserveOrder: true,
});
function xml(data: Uint8Array): unknown {
  const text = strFromU8(data);
  if (/<!DOCTYPE|<!ENTITY/iu.test(text)) throw new Error('XML declarations are unsupported');
  return xmlParser.parse(text) as unknown;
}
function orderedXml(data: Uint8Array): unknown {
  const text = strFromU8(data);
  if (/<!DOCTYPE|<!ENTITY/iu.test(text)) throw new Error('XML declarations are unsupported');
  return orderedXmlParser.parse(text) as unknown;
}
function texts(value: unknown, keys: string[]): string[] {
  if (!value || typeof value !== 'object') return [];
  const result: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (keys.includes(key)) {
      for (const item of Array.isArray(child) ? child : [child]) {
        if (typeof item === 'string' || typeof item === 'number') result.push(String(item));
        else if (item && typeof item === 'object' && '#text' in item)
          result.push(String((item as Record<string, unknown>)['#text']));
      }
    } else if (Array.isArray(child)) for (const item of child) result.push(...texts(item, keys));
    else result.push(...texts(child, keys));
  }
  return result;
}
function elements(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== 'object') return [];
  const result: unknown[] = [];
  for (const [name, child] of Object.entries(value)) {
    if (name === key) result.push(child);
    else if (Array.isArray(child)) for (const item of child) result.push(...elements(item, key));
    else result.push(...elements(child, key));
  }
  return result;
}
async function processSource(): Promise<Output> {
  sharp.cache(false);
  sharp.concurrency(1);
  if (extension === 'pdf' && bytes.subarray(0, 5).toString() === '%PDF-') {
    output.mediaType = 'application/pdf';
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const { createCanvas } = await import('@napi-rs/canvas');
    const task = getDocument({
      data: new Uint8Array(bytes),
      standardFontDataUrl: fileURLToPath(
        new URL('../standard_fonts/', import.meta.resolve('pdfjs-dist/build/pdf.mjs')),
      ),
      wasmUrl: fileURLToPath(new URL('../wasm/', import.meta.resolve('pdfjs-dist/build/pdf.mjs'))),
      disableFontFace: true,
      useSystemFonts: false,
      maxImageSize: 16_000_000,
      stopAtErrors: true,
    });
    try {
      const pdf = await task.promise;
      for (let n = 1; n <= Math.min(pdf.numPages, 50); n++) {
        const page = await pdf.getPage(n);
        const text = await page.getTextContent();
        output.locators.push({
          label: `Page ${n}`,
          text: text.items.map((item) => ('str' in item ? item.str : '')).join(' '),
        });
        if (n <= 20) {
          const original = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({
            scale: Math.min(1, 768 / Math.max(original.width, original.height)),
          });
          const canvas = createCanvas(
            Math.max(1, Math.ceil(viewport.width)),
            Math.max(1, Math.ceil(viewport.height)),
          );
          await page.render({
            canvas,
            canvasContext: canvas.getContext('2d'),
            viewport,
          }).promise;
          output.previews.push({
            label: `Page ${n}`,
            mediaType: 'image/png',
            base64: canvas.toBuffer('image/png').toString('base64'),
          });
        }
        page.cleanup();
      }
      output.processingState = 'ready';
      output.processingNote = `Extracted up to 50 pages and rendered up to 20 previews (${pdf.numPages} pages total). No OCR; scanned pages may have no searchable text.`;
    } finally {
      await task.destroy();
    }
  } else if (['png', 'jpg', 'jpeg', 'svg'].includes(extension ?? '')) {
    const expected = extension === 'jpg' ? 'jpeg' : extension;
    if (extension === 'svg') {
      const svg = bytes.toString('utf8');
      if (
        /<!DOCTYPE|<!ENTITY|<script|<foreignObject|\bon\w+\s*=|\b(?:href|src)\s*=|url\s*\(|@import/iu.test(
          svg,
        )
      ) {
        output.processingNote =
          'SVG retained; active content and external references are not previewed.';
        return output;
      }
    }
    const image = sharp(bytes, { limitInputPixels: 16_000_000 });
    const meta = await image.metadata();
    if (meta.format !== expected) throw new Error('File content does not match its extension');
    output.mediaType = expected === 'svg' ? 'image/svg+xml' : `image/${expected}`;
    const preview = await image
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    output.previews.push({
      label: 'Image',
      mediaType: 'image/png',
      base64: preview.toString('base64'),
    });
    output.processingState = 'ready';
    output.processingNote =
      'Image preview available. No OCR or semantic image interpretation has been performed.';
  } else if (
    ['docx', 'pptx', 'xlsx'].includes(extension ?? '') &&
    bytes.subarray(0, 2).toString() === 'PK'
  ) {
    let total = 0,
      count = 0;
    const files = unzipSync(bytes, {
      filter(file) {
        if (
          ++count > 4000 ||
          file.originalSize > 8 * 1024 * 1024 ||
          (total += file.originalSize) > 32 * 1024 * 1024
        )
          throw new Error('Office archive exceeds processing limits');
        if (/vbaProject|\.bin$/iu.test(file.name))
          throw new Error('Macro and embedded binary content is unsupported');
        return file.name.endsWith('.xml');
      },
    });
    const required =
      extension === 'docx'
        ? 'word/document.xml'
        : extension === 'pptx'
          ? 'ppt/presentation.xml'
          : 'xl/workbook.xml';
    if (!files[required] || !files['[Content_Types].xml'])
      throw new Error('File is not a matching Office document');
    output.mediaType = `application/vnd.openxmlformats-officedocument.${extension === 'docx' ? 'wordprocessingml.document' : extension === 'pptx' ? 'presentationml.presentation' : 'spreadsheetml.sheet'}`;
    if (extension === 'docx') {
      const document = orderedXml(files[required]);
      output.locators.push({
        label: 'Document',
        text: elements(document, 'p')
          .map((paragraph) => texts(paragraph, ['t']).join(''))
          .filter(Boolean)
          .join('\n'),
      });
    }
    if (extension === 'pptx') {
      const slides = Object.keys(files)
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
        .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
      for (const name of slides.slice(0, 100))
        output.locators.push({
          label: `Slide part ${name.match(/slide(\d+)\.xml$/u)?.[1] ?? name}`,
          text: texts(xml(files[name]!), ['t']).join('\n'),
        });
    }
    if (extension === 'xlsx') {
      const shared = files['xl/sharedStrings.xml']
        ? (xml(files['xl/sharedStrings.xml']) as { sst?: { si?: unknown } })
        : undefined;
      const entries = shared?.sst?.si;
      const strings = (
        entries === undefined ? [] : Array.isArray(entries) ? entries : [entries]
      ).map((entry) => texts(entry, ['t']).join(''));
      for (const name of Object.keys(files)
        .filter((key) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(key))
        .slice(0, 100)) {
        const parsed = xml(files[name]!);
        const cells: string[] = [];
        const visit = (value: unknown): void => {
          if (!value || typeof value !== 'object') return;
          if (Array.isArray(value)) {
            value.forEach(visit);
            return;
          }
          const record = value as Record<string, unknown>;
          if ('@_r' in record && ('v' in record || 'is' in record))
            cells.push(
              `${String(record['@_r'])}: ${record['@_t'] === 's' ? (strings[Number(record.v)] ?? '') : typeof record.v === 'string' || typeof record.v === 'number' ? String(record.v) : texts(record.is, ['t']).join('')}`,
            );
          else Object.values(record).forEach(visit);
        };
        visit(parsed);
        output.locators.push({ label: name, text: cells.join('\n') });
      }
    }
    output.processingState = 'ready';
    output.processingNote =
      'Text extracted from up to 100 slide/sheet parts; locators identify original XML parts. Layout, fonts, charts and colors require opening the original. Formulas are not executed.';
  }
  let remaining = 180_000;
  output.locators = output.locators.map((part) => {
    const text = Buffer.from(part.text).subarray(0, Math.max(0, remaining)).toString('utf8');
    remaining -= Buffer.byteLength(text);
    return { ...part, text };
  });
  if (remaining <= 0)
    output.processingNote += ' Searchable text was truncated at the extraction limit.';
  let previewBytes = 0;
  output.previews = output.previews.filter(
    (preview) => (previewBytes += preview.base64.length) <= 8 * 1024 * 1024,
  );
  return output;
}
void processSource()
  .then((result) => process.stdout.write(JSON.stringify(result)))
  .catch((error: unknown) => {
    output.processingState = 'failed';
    output.processingNote = `Original retained; extraction unavailable: ${error instanceof Error ? error.message.slice(0, 200) : 'processing failed'}`;
    output.locators = [];
    output.previews = [];
    process.stdout.write(JSON.stringify(output));
  });
