import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ingestKnowledgeBytes, knowledgeExtractionPath } from './knowledge-file-ingest.js';
import {
  createImageTextExtractor,
  IMAGE_TEXT_HEADING,
  IMAGE_TEXT_MAX_BYTES,
  imageMediaType,
  type ImageTextExtractorDeps,
} from './knowledge-image-text.js';

// A 1×1 PNG: real bytes, so the regular extractor writes the artifact the model
// section is appended to.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const RELATIVE = 'sources/documents/matrix/room/attachments/event-receipt.png';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'verity-image-text-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function extractor(answer: string | undefined, overrides: Partial<ImageTextExtractorDeps> = {}) {
  const query = vi.fn<ImageTextExtractorDeps['query']>(async () => answer);
  const onError = vi.fn();
  const modelFor = vi.fn(async () => 'claude-opus-5-5');
  return {
    query,
    onError,
    modelFor,
    instance: createImageTextExtractor({ query, cwd: '/repo', modelFor, onError, ...overrides }),
  };
}

const artifact = () => readFile(knowledgeExtractionPath(root, RELATIVE), 'utf8');

it("appends the model's transcription to the image's artifact using the project model", async () => {
  await ingestKnowledgeBytes(root, RELATIVE, PNG);
  const { instance, query, modelFor } = extractor('ACME GmbH\nTotal 42,00 EUR');

  expect(instance.enqueue({ projectId: 'p1', root, relativePath: RELATIVE, bytes: PNG })).toBe(
    true,
  );
  await instance.idle();

  expect(modelFor).toHaveBeenCalledWith('p1');
  expect(query).toHaveBeenCalledWith(
    expect.objectContaining({
      model: 'claude-opus-5-5',
      attachments: [{ kind: 'image', mediaType: 'image/png', data: PNG.toString('base64') }],
    }),
  );
  const markdown = await artifact();
  expect(markdown).toContain(`Source: ${RELATIVE}`);
  expect(markdown).toContain(`## ${IMAGE_TEXT_HEADING}\n\nACME GmbH\nTotal 42,00 EUR\n`);
});

it('does not ask the model again for a re-delivered image', async () => {
  await ingestKnowledgeBytes(root, RELATIVE, PNG);
  const first = extractor('Hello');
  first.instance.enqueue({ projectId: 'p1', root, relativePath: RELATIVE, bytes: PNG });
  await first.instance.idle();
  const retry = extractor('Hello again');
  retry.instance.enqueue({ projectId: 'p1', root, relativePath: RELATIVE, bytes: PNG });
  await retry.instance.idle();

  expect(retry.query).not.toHaveBeenCalled();
  expect((await artifact()).split(`## ${IMAGE_TEXT_HEADING}`)).toHaveLength(2);
});

it('writes nothing when the image was redacted while the model was reading it', async () => {
  await ingestKnowledgeBytes(root, RELATIVE, PNG);
  const before = await artifact();
  const { instance } = extractor(undefined, {
    query: async () => {
      await unlink(join(root, RELATIVE));
      return 'Secret';
    },
  });
  instance.enqueue({ projectId: 'p1', root, relativePath: RELATIVE, bytes: PNG });
  await instance.idle();

  expect(await artifact()).toBe(before);
});

it('records a failed call as an error, not as an image without text', async () => {
  await ingestKnowledgeBytes(root, RELATIVE, PNG);
  const { instance, onError } = extractor(undefined);
  instance.enqueue({ projectId: 'p1', root, relativePath: RELATIVE, bytes: PNG });
  await instance.idle();

  expect(onError).toHaveBeenCalledTimes(1);
  expect(await artifact()).not.toContain(IMAGE_TEXT_HEADING);

  const empty = extractor('NO_TEXT');
  empty.instance.enqueue({ projectId: 'p1', root, relativePath: RELATIVE, bytes: PNG });
  await empty.instance.idle();
  expect(await artifact()).toContain(`## ${IMAGE_TEXT_HEADING}\n\n_No legible text._\n`);
});

it('ignores files that are not images, and images too large to send', async () => {
  const { instance, query } = extractor('x');
  const text = Buffer.from('%PDF-1.7 not an image');
  await writeFile(join(root, 'doc.pdf'), text);

  expect(instance.enqueue({ projectId: 'p1', root, relativePath: 'doc.pdf', bytes: text })).toBe(
    false,
  );
  const huge = Buffer.concat([PNG, Buffer.alloc(IMAGE_TEXT_MAX_BYTES)]);
  expect(instance.enqueue({ projectId: 'p1', root, relativePath: RELATIVE, bytes: huge })).toBe(
    false,
  );
  await instance.idle();
  expect(query).not.toHaveBeenCalled();
});

it('recognises image types by content rather than file name', () => {
  expect(imageMediaType(PNG)).toBe('image/png');
  expect(imageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  expect(imageMediaType(Buffer.from('GIF89a......'))).toBe('image/gif');
  expect(imageMediaType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
  expect(imageMediaType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(undefined);
});
