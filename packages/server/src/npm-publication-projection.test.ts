import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { expect, it } from 'vitest';
import { MAX_NPM_PUBLICATION_BYTES, projectNpmPublications } from './npm-publication-projection.js';

function response(
  chunks: Iterable<Buffer | string>,
  headers: Record<string, string> = {},
): IncomingMessage {
  return Object.assign(Readable.from(chunks), { headers }) as IncomingMessage;
}
const facts = {
  name: 'example',
  versions: { '1.0.0': { description: 'ignored' } },
  time: { '1.0.0': '2020-01-01T00:00:00Z' },
};
const signal = new AbortController().signal;

it('projects facts across arbitrary UTF-8 and escaped string boundaries', async () => {
  const bytes = Buffer.from(
    JSON.stringify({ description: 'é 🌈 \\ "', ...facts }).replace('example', 'exa\\u006dple'),
  );
  const input = response(Array.from(bytes, (byte) => Buffer.from([byte])));
  const result = await projectNpmPublications(
    input,
    'example',
    new Set(['1.0.0', '2.0.0']),
    signal,
  );
  expect(result.versions).toEqual(new Set(['1.0.0']));
  expect(result.times).toEqual(new Map([['1.0.0', '2020-01-01T00:00:00Z']]));
  expect(input.destroyed).toBe(true);
});

it('discards a multi-MiB unrelated manifest string while retaining only requested facts', async () => {
  const input = response([
    '{"description":"',
    'x'.repeat(3 * 1024 ** 2),
    '","name":"example","versions":{"0.0.0":{"description":"',
    'y'.repeat(3 * 1024 ** 2),
    '"},"1.0.0":{}},"time":{"0.0.0":"ignored","1.0.0":"2020-01-01T00:00:00Z"}}',
  ]);
  const result = await projectNpmPublications(input, 'example', new Set(['1.0.0']), signal);
  expect(result.versions).toEqual(new Set(['1.0.0']));
  expect(result.times).toEqual(new Map([['1.0.0', '2020-01-01T00:00:00Z']]));
});

it.each([true, false])(
  'projects a large packument with Content-Length present: %s',
  async (withLength) => {
    const prefix = '{"description":"';
    const suffix = '",' + JSON.stringify(facts).slice(1);
    const chunk = Buffer.alloc(1024 ** 2, 97);
    const count = 40;
    function* chunks() {
      yield prefix;
      for (let i = 0; i < count; i++) yield chunk;
      yield suffix;
    }
    const length = Buffer.byteLength(prefix + suffix) + count * chunk.length;
    const input = response(chunks(), withLength ? { 'content-length': String(length) } : {});
    const result = await projectNpmPublications(input, 'example', new Set(['1.0.0']), signal);
    expect(result.versions).toEqual(new Set(['1.0.0']));
    expect(result.times).toEqual(new Map([['1.0.0', '2020-01-01T00:00:00Z']]));
    expect(input.destroyed).toBe(true);
  },
  30_000,
);

it.each([
  '{"name":"example","versions":{"1.0.0":{}},"time":{"1.0.0":"a","1.0.0":"b"}}',
  '{"name":"example","versions":{"1.0.0":{},"1.0.0":{}}}',
  '{"name":"example","name":"foreign"}',
  '{"name":"example","versions":{},"versions":{}}',
  '{"name":"example","description":"bad\\q"}',
  '{"name":"example","description":"bad\n"}',
  '{"name":"example",}',
  '{"name":"example","unused":[1,]}',
  '{"name":"example","unused":[01]}',
  '{"name":"example","unused":truefalse}',
  '{"name":"example","unused":',
  '{"name":"example"} garbage',
  '{"name":"foreign"}',
])('rejects malformed or ambiguous metadata %s', async (data) => {
  await expect(
    projectNpmPublications(response([data]), 'example', new Set(['1.0.0']), signal),
  ).rejects.toThrow();
});

it('bounds nesting, input bytes and content encodings and rejects invalid UTF-8', async () => {
  for (const input of [
    response(['{"name":"example","unused":' + '['.repeat(65) + '0' + ']'.repeat(65) + '}']),
    response(['{}'], { 'content-length': String(MAX_NPM_PUBLICATION_BYTES + 1) }),
    response(['{}'], { 'content-encoding': 'gzip' }),
    response([Buffer.from([255])]),
  ])
    await expect(projectNpmPublications(input, 'example', new Set(), signal)).rejects.toThrow();
});

it('bounds streamed bytes without buffering or requiring a Content-Length', async () => {
  const chunk = Buffer.alloc(1024 ** 2, 97);
  function* chunks() {
    yield '{"name":"example","description":"';
    for (let i = 0; i < MAX_NPM_PUBLICATION_BYTES / chunk.length + 1; i++) yield chunk;
    yield '"}';
  }
  await expect(
    projectNpmPublications(response(chunks()), 'example', new Set(), signal),
  ).rejects.toThrow();
}, 30_000);

it('destroys the source when the generation is aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const input = response([JSON.stringify(facts)]);
  await expect(
    projectNpmPublications(input, 'example', new Set(['1.0.0']), controller.signal),
  ).rejects.toThrow();
  expect(input.destroyed).toBe(true);
});
