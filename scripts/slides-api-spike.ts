/**
 * Spike for ADR 0016 — verifies the assumptions before anything is built on them:
 *
 *   D5  Google's image fetch resolves a DRIVE-HOSTED url, so `createImage` and
 *       `stretchedPictureFill` work without the Verity server being publicly
 *       reachable. Several url shapes are tried; the report names which ones work.
 *       This is the LOAD-BEARING one: a failure here changes what inserting an
 *       image costs.
 *   D6  `presentations.pages.getThumbnail` returns a fetchable image, for previews
 *       the operator explicitly asks for. Cheap to check while we are here; a
 *       failure costs a convenience, not a feature.
 *
 * Two secondary checks come along cheaply because the scaffolding is already there:
 * the D3 edit vocabulary (text box + insertText) and the D2 revision guard — that a
 * batch carrying a STALE `requiredRevisionId` is actually rejected rather than
 * silently applied. D2 is the one assumption whose failure would be invisible in
 * normal use and destructive in the case it exists for.
 *
 * Everything runs against a throwaway presentation this script creates and deletes.
 * It never writes to an existing deck: with DECK_ID set it additionally does a
 * READ-ONLY pass (get + thumbnail) against that deck, which is what exercises the
 * `presentations` scope on a file the app did not create — the D4 case.
 *
 * Usage:
 *   GOOGLE_ACCESS_TOKEN=ya29.… node scripts/slides-api-spike.ts
 *   # or drop the token in a file (keeps it out of shell history and transcripts):
 *   node scripts/slides-api-spike.ts            # reads /tmp/verity-google-token
 *   DECK_ID=<id> node scripts/slides-api-spike.ts   # also probe an existing deck
 *   KEEP=1 node scripts/slides-api-spike.ts          # skip cleanup, inspect by hand
 *
 * The token needs the scopes `drive.file` and `presentations`, and the Slides API
 * must be enabled in the Google Cloud project.
 */
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SLIDES = 'https://slides.googleapis.com/v1';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

// ---------------------------------------------------------------- token

function readToken(): string {
  const inline = process.env.GOOGLE_ACCESS_TOKEN?.trim();
  if (inline !== undefined && inline.length > 0) return inline;
  const path = process.env.GOOGLE_ACCESS_TOKEN_FILE ?? '/tmp/verity-google-token';
  try {
    const fromFile = readFileSync(path, 'utf8').trim();
    if (fromFile.length > 0) return fromFile;
  } catch {
    /* fall through to the error below */
  }
  console.error(
    `No access token. Set GOOGLE_ACCESS_TOKEN, or write one to ${path}.\n` +
      'Scopes required: https://www.googleapis.com/auth/drive.file and ' +
      'https://www.googleapis.com/auth/presentations',
  );
  process.exit(2);
}

const TOKEN = readToken();

// ---------------------------------------------------------------- reporting

interface Check {
  id: string;
  what: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
function record(id: string, what: string, ok: boolean, detail = ''): void {
  checks.push({ id, what, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
}

/** Google error bodies carry a human-readable `error.message`; keep it, it is the
 *  whole point of a spike. Truncated so a stray html error page stays readable. */
function errorText(status: number, body: unknown): string {
  const message = (body as { error?: { message?: unknown } } | undefined)?.error?.message;
  const text = typeof message === 'string' ? message : JSON.stringify(body);
  return `HTTP ${String(status)}: ${(text ?? '').slice(0, 300)}`;
}

// ---------------------------------------------------------------- http

interface ApiResult {
  status: number;
  ok: boolean;
  body: unknown;
}

async function call(
  url: string,
  init: { method?: string; body?: string | Buffer; contentType?: string } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` };
  if (init.contentType !== undefined) headers['Content-Type'] = init.contentType;
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    /* keep the raw text */
  }
  return { status: res.status, ok: res.ok, body };
}

const json = (value: unknown): string => JSON.stringify(value);

// ---------------------------------------------------------------- test image

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A recognisable gradient, so a thumbnail that comes back can be eyeballed as
 *  "yes, that is our image" rather than "some png arrived". */
function gradientPng(width: number, height: number): Buffer {
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const p = row + 1 + x * 3;
      raw[p] = Math.round((x / Math.max(1, width - 1)) * 255);
      raw[p + 1] = 40;
      raw[p + 2] = Math.round((y / Math.max(1, height - 1)) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- steps

async function createScratchDeck(): Promise<{ id: string; slideId: string }> {
  const res = await call(`${SLIDES}/presentations`, {
    method: 'POST',
    contentType: 'application/json',
    body: json({ title: `Verity ADR-0016 spike ${new Date().toISOString()}` }),
  });
  if (!res.ok) {
    record('setup', 'create scratch presentation', false, errorText(res.status, res.body));
    process.exit(1);
  }
  const deck = res.body as { presentationId: string; slides?: { objectId: string }[] };
  const slideId = deck.slides?.[0]?.objectId ?? '';
  record('setup', 'create scratch presentation', slideId.length > 0, deck.presentationId);
  return { id: deck.presentationId, slideId };
}

async function uploadImage(png: Buffer): Promise<{ id: string; webContentLink?: string }> {
  const boundary = 'verity-spike-boundary';
  const metadata = json({ name: 'verity-spike-image.png', mimeType: 'image/png' });
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
        `--${boundary}\r\nContent-Type: image/png\r\n\r\n`,
    ),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await call(
    `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,webContentLink,webViewLink`,
    { method: 'POST', contentType: `multipart/related; boundary=${boundary}`, body },
  );
  if (!res.ok) {
    record('D5', 'upload test image to Drive', false, errorText(res.status, res.body));
    process.exit(1);
  }
  const file = res.body as { id: string; webContentLink?: string };
  record('D5', 'upload test image to Drive', true, `${String(png.length)} bytes, id ${file.id}`);
  return file;
}

async function batchUpdate(
  presentationId: string,
  requests: unknown[],
  requiredRevisionId?: string,
): Promise<ApiResult> {
  return call(`${SLIDES}/presentations/${presentationId}:batchUpdate`, {
    method: 'POST',
    contentType: 'application/json',
    body: json({
      requests,
      ...(requiredRevisionId === undefined ? {} : { writeControl: { requiredRevisionId } }),
    }),
  });
}

/** The D5 core: try each url shape and report which ones Google accepts. */
async function probeImageUrls(
  presentationId: string,
  slideId: string,
  fileId: string,
  webContentLink: string | undefined,
  label: string,
): Promise<string | undefined> {
  const candidates: { name: string; url: string }[] = [
    { name: 'lh3 /d/<id>', url: `https://lh3.googleusercontent.com/d/${fileId}` },
    { name: 'drive uc export=view', url: `https://drive.google.com/uc?export=view&id=${fileId}` },
    { name: 'drive uc', url: `https://drive.google.com/uc?id=${fileId}` },
    ...(webContentLink === undefined ? [] : [{ name: 'webContentLink', url: webContentLink }]),
  ];
  let working: string | undefined;
  for (const candidate of candidates) {
    const res = await batchUpdate(presentationId, [
      {
        createImage: {
          url: candidate.url,
          elementProperties: {
            pageObjectId: slideId,
            size: {
              width: { magnitude: 200, unit: 'PT' },
              height: { magnitude: 112.5, unit: 'PT' },
            },
            transform: { scaleX: 1, scaleY: 1, translateX: 40, translateY: 40, unit: 'PT' },
          },
        },
      },
    ]);
    record(
      'D5',
      `createImage via ${candidate.name} (${label})`,
      res.ok,
      res.ok ? '' : errorText(res.status, res.body),
    );
    if (res.ok && working === undefined) working = candidate.url;
  }
  return working;
}

async function shareAnyoneWithLink(fileId: string): Promise<boolean> {
  const res = await call(`${DRIVE}/files/${fileId}/permissions`, {
    method: 'POST',
    contentType: 'application/json',
    body: json({ role: 'reader', type: 'anyone' }),
  });
  record(
    'D5',
    'grant anyone-with-link on the image',
    res.ok,
    res.ok ? '' : errorText(res.status, res.body),
  );
  return res.ok;
}

async function checkBackgroundFill(
  presentationId: string,
  slideId: string,
  url: string,
): Promise<void> {
  const res = await batchUpdate(presentationId, [
    {
      updatePageProperties: {
        objectId: slideId,
        pageProperties: { pageBackgroundFill: { stretchedPictureFill: { contentUrl: url } } },
        fields: 'pageBackgroundFill',
      },
    },
  ]);
  record(
    'D5',
    'slide background via stretchedPictureFill',
    res.ok,
    res.ok ? '' : errorText(res.status, res.body),
  );
}

async function checkTextBox(presentationId: string, slideId: string): Promise<void> {
  const boxId = 'verity_spike_box';
  const res = await batchUpdate(presentationId, [
    {
      createShape: {
        objectId: boxId,
        shapeType: 'TEXT_BOX',
        elementProperties: {
          pageObjectId: slideId,
          size: {
            width: { magnitude: 300, unit: 'PT' },
            height: { magnitude: 60, unit: 'PT' },
          },
          transform: { scaleX: 1, scaleY: 1, translateX: 40, translateY: 200, unit: 'PT' },
        },
      },
    },
    { insertText: { objectId: boxId, text: 'ADR 0016 spike' } },
  ]);
  record(
    'D3',
    'createShape TEXT_BOX + insertText',
    res.ok,
    res.ok ? '' : errorText(res.status, res.body),
  );
}

/** D6: a thumbnail url is worthless if it cannot actually be fetched, so fetch it. */
async function checkThumbnail(presentationId: string, slideId: string, id: string): Promise<void> {
  const res = await call(
    `${SLIDES}/presentations/${presentationId}/pages/${slideId}/thumbnail` +
      '?thumbnailProperties.mimeType=PNG&thumbnailProperties.thumbnailSize=MEDIUM',
  );
  if (!res.ok) {
    record(id, 'getThumbnail', false, errorText(res.status, res.body));
    return;
  }
  const thumb = res.body as { contentUrl?: string; width?: number; height?: number };
  const url = thumb.contentUrl;
  if (typeof url !== 'string') {
    record(id, 'getThumbnail', false, 'no contentUrl in response');
    return;
  }
  record(id, 'getThumbnail', true, `${String(thumb.width)}x${String(thumb.height)}`);

  // The thumbnail url is short-lived and unauthenticated — fetch it WITHOUT the
  // bearer token, which is how the chat would consume it.
  const image = await fetch(url);
  const bytes = image.ok ? (await image.arrayBuffer()).byteLength : 0;
  const isPng = bytes > 8;
  record(
    id,
    'thumbnail contentUrl is fetchable',
    image.ok && isPng,
    image.ok ? `${String(bytes)} bytes` : `HTTP ${String(image.status)}`,
  );
}

/** D2: the guard only earns its place if a stale revision is actually refused. */
async function checkRevisionGuard(presentationId: string, slideId: string): Promise<void> {
  const before = await call(`${SLIDES}/presentations/${presentationId}?fields=revisionId`);
  const staleRevision = (before.body as { revisionId?: string }).revisionId;
  if (typeof staleRevision !== 'string') {
    record('D2', 'read revisionId', false, errorText(before.status, before.body));
    return;
  }

  const first = await batchUpdate(presentationId, [{ createSlide: {} }], staleRevision);
  record(
    'D2',
    'batchUpdate with current revisionId succeeds',
    first.ok,
    first.ok ? '' : errorText(first.status, first.body),
  );

  // Same revision id again — it is now stale, because the edit above moved the deck on.
  const second = await batchUpdate(
    presentationId,
    [{ insertText: { objectId: slideId, text: 'x' } }],
    staleRevision,
  );
  record(
    'D2',
    'batchUpdate with STALE revisionId is rejected',
    !second.ok,
    second.ok
      ? 'ACCEPTED — the guard does not fire, D2 is wrong'
      : errorText(second.status, second.body),
  );
}

/** D4: read-only probe of a deck the app did not create. Never writes. */
async function probeExistingDeck(deckId: string): Promise<void> {
  const res = await call(
    `${SLIDES}/presentations/${deckId}?fields=presentationId,revisionId,layouts.objectId,layouts.layoutProperties.displayName,slides.objectId`,
  );
  if (!res.ok) {
    record(
      'D4',
      'read an existing deck (presentations scope)',
      false,
      errorText(res.status, res.body),
    );
    return;
  }
  const deck = res.body as {
    revisionId?: string;
    layouts?: { layoutProperties?: { displayName?: string } }[];
    slides?: { objectId: string }[];
  };
  const layouts = (deck.layouts ?? [])
    .map((l) => l.layoutProperties?.displayName)
    .filter((n): n is string => typeof n === 'string');
  record(
    'D4',
    'read an existing deck (presentations scope)',
    true,
    `${String(deck.slides?.length ?? 0)} slides, layouts: ${layouts.slice(0, 8).join(', ')}`,
  );
  const firstSlide = deck.slides?.[0]?.objectId;
  if (firstSlide !== undefined) await checkThumbnail(deckId, firstSlide, 'D4');
}

async function cleanUp(ids: string[]): Promise<void> {
  if (process.env.KEEP === '1') {
    console.log(`\nKEEP=1 — leaving behind: ${ids.join(', ')}`);
    return;
  }
  for (const id of ids) {
    const res = await call(`${DRIVE}/files/${id}`, { method: 'DELETE' });
    if (!res.ok) console.log(`  cleanup failed for ${id}: ${errorText(res.status, res.body)}`);
  }
}

// ---------------------------------------------------------------- main

const created: string[] = [];
try {
  console.log('ADR 0016 spike — Slides API assumptions\n');

  const deck = await createScratchDeck();
  created.push(deck.id);

  const image = await uploadImage(gradientPng(640, 360));
  created.push(image.id);

  let workingUrl = await probeImageUrls(
    deck.id,
    deck.slideId,
    image.id,
    image.webContentLink,
    'private',
  );

  // If the private file was refused, find out whether link-sharing is what it takes.
  // That distinction decides whether D5 is cheap or forces a sharing side effect.
  if (workingUrl === undefined && (await shareAnyoneWithLink(image.id))) {
    workingUrl = await probeImageUrls(
      deck.id,
      deck.slideId,
      image.id,
      image.webContentLink,
      'link-shared',
    );
  }

  if (workingUrl !== undefined) await checkBackgroundFill(deck.id, deck.slideId, workingUrl);
  else record('D5', 'slide background via stretchedPictureFill', false, 'skipped — no url worked');

  await checkTextBox(deck.id, deck.slideId);
  await checkThumbnail(deck.id, deck.slideId, 'D6');
  await checkRevisionGuard(deck.id, deck.slideId);

  const existing = process.env.DECK_ID;
  if (existing !== undefined && existing.length > 0) await probeExistingDeck(existing);
  else console.log('  skip  D4 existing-deck probe (set DECK_ID to run it)');
} finally {
  await cleanUp(created);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
if (failed.length > 0) {
  console.log('failed:');
  for (const c of failed) console.log(`  [${c.id}] ${c.what} — ${c.detail}`);
  process.exitCode = 1;
}
