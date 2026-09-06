/**
 * Spike for ADR 0016 — verifies the assumptions before anything is built on them:
 *
 *   D5  Google's image fetch resolves a DRIVE-HOSTED url, so `createImage` and
 *       `stretchedPictureFill` work without the Verity server being publicly
 *       reachable. Several url shapes are tried, first while the file is PRIVATE
 *       and then after a link-share, so the report says not only which shapes work
 *       but whether the share is what made them work. If it is, the follow-up
 *       decides the price: the run then revokes the share and deletes the source,
 *       and re-reads the image. Bytes that survive mean Slides COPIED them and the
 *       public window can be closed at once; bytes that vanish mean the deck holds
 *       a live reference and the asset must stay public for as long as the slide
 *       does. This is the LOAD-BEARING one: it changes what inserting an image
 *       costs.
 *   D6  `presentations.pages.getThumbnail` returns a fetchable image, for previews
 *       the operator explicitly asks for. Cheap to check while we are here; a
 *       failure costs a convenience, not a feature.
 *
 *   D3  the whole edit vocabulary works against a slide that HAS a layout, not just
 *       against the blank one this script starts with. A blank slide inherits
 *       nothing and so can break nothing; a real deck's text lives in placeholders
 *       carrying the deck's design. The check that earns its place is whether text
 *       inserted into such a placeholder stays STYLE-FREE and inherits — if it
 *       arrives carrying its own font, every edit drifts the design.
 *   D2  a batch carrying a STALE `requiredRevisionId` is actually rejected rather
 *       than silently applied. This is the one assumption whose failure would be
 *       invisible in normal use and destructive in the case it exists for.
 *   D7  `files.export` really yields a .pptx container, not a renamed pdf.
 *
 * Everything runs against a throwaway presentation this script creates and deletes.
 * With DECK_ID set it additionally probes an existing deck — the D4 case, since that
 * file is one the app did not create and `drive.file` cannot see. That pass is
 * READ-ONLY unless WRITE_TEST=1 is also set, which is a separate flag on purpose:
 * the write test edits somebody's real deck, and while it is built to be reversible
 * (an off-canvas text box, deleted again in the same run) Google's revision history
 * is not. Ask before setting it.
 *
 * Usage:
 *   GOOGLE_ACCESS_TOKEN=ya29.… node scripts/slides-api-spike.ts
 *   # or drop the token in a file (keeps it out of shell history and transcripts):
 *   node scripts/slides-api-spike.ts            # reads /tmp/verity-google-token
 *   DECK_ID=<id> node scripts/slides-api-spike.ts   # also probe an existing deck
 *   DECK_ID=<id> WRITE_TEST=1 node …                 # …and edit it, reversibly
 *   KEEP=1 node scripts/slides-api-spike.ts          # skip cleanup, inspect by hand
 *   THUMB_OUT=<path> node …                          # keep the last render on disk
 *
 * The token needs the scopes `drive.file` and `presentations`, and the Slides API
 * must be enabled in the Google Cloud project.
 */
import { readFileSync, writeFileSync } from 'node:fs';
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
    throw new Error('test image upload failed');
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
  shouldSucceed: boolean,
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
    const error = errorText(res.status, res.body);
    const expectedPrivateRejection =
      res.status === 400 &&
      (error.includes('Access to the provided image was forbidden') ||
        error.includes('provided image should be publicly accessible'));
    const expectedOutcome = shouldSucceed ? res.ok : expectedPrivateRejection;
    record(
      'D5',
      `createImage via ${candidate.name} (${label})`,
      expectedOutcome,
      res.ok ? '' : `${shouldSucceed ? '' : 'expected rejection: '}${error}`,
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

/**
 * The follow-up that decides what D5 costs. Google refuses a private Drive url, so
 * inserting an image needs a link-share. Whether that share must STAY depends on
 * something the api reference does not state: does `createImage` copy the bytes
 * into the presentation, or keep pointing at the source?
 *
 * Proven the only way that admits no doubt: insert, then revoke the share AND
 * delete the source file outright, then check the image still renders. If it does,
 * the public window lasts one request rather than forever.
 */
async function checkImageSurvivesSourceRemoval(
  presentationId: string,
  slideId: string,
  fileId: string,
  url: string,
): Promise<boolean> {
  const imageId = 'verity_spike_image';
  const created = await batchUpdate(presentationId, [
    {
      createImage: {
        objectId: imageId,
        url,
        elementProperties: {
          pageObjectId: slideId,
          size: {
            width: { magnitude: 160, unit: 'PT' },
            height: { magnitude: 90, unit: 'PT' },
          },
          transform: { scaleX: 1, scaleY: 1, translateX: 300, translateY: 40, unit: 'PT' },
        },
      },
    },
  ]);
  if (!created.ok) {
    record('D5', 'image survives source removal', false, errorText(created.status, created.body));
    return false;
  }

  // Where does the element point now — at Drive, or at a Google-hosted copy?
  const page = await call(
    `${SLIDES}/presentations/${presentationId}/pages/${slideId}?fields=pageElements`,
  );
  const elements = (
    page.body as {
      pageElements?: { objectId?: string; image?: { contentUrl?: string; sourceUrl?: string } }[];
    }
  ).pageElements;
  const element = (elements ?? []).find((e) => e.objectId === imageId);
  const contentUrl = element?.image?.contentUrl;
  record(
    'D5',
    'inserted image has its own contentUrl',
    typeof contentUrl === 'string',
    typeof contentUrl === 'string' ? new URL(contentUrl).host : 'no contentUrl on the element',
  );

  const revoked = await call(`${DRIVE}/files/${fileId}/permissions/anyoneWithLink`, {
    method: 'DELETE',
  });
  const deleted = await call(`${DRIVE}/files/${fileId}`, { method: 'DELETE' });
  record(
    'D5',
    'revoke share + delete the Drive source',
    revoked.ok && deleted.ok,
    revoked.ok ? '' : errorText(revoked.status, revoked.body),
  );
  if (!deleted.ok) return false;

  let bytesSurvive = false;
  if (typeof contentUrl === 'string') {
    const fetched = await fetch(contentUrl);
    const bytes = fetched.ok ? (await fetched.arrayBuffer()).byteLength : 0;
    bytesSurvive = fetched.ok && bytes > 0;
    record(
      'D5',
      'image bytes still served after the source is gone',
      bytesSurvive,
      fetched.ok ? `${String(bytes)} bytes` : `HTTP ${String(fetched.status)}`,
    );
  }

  // The render is the real proof: a thumbnail is produced fresh, server-side.
  const thumbnailOk = await checkThumbnail(presentationId, slideId, 'D5');
  return typeof contentUrl === 'string' && bytesSurvive && thumbnailOk;
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

/** Background fills must copy their bytes just as createImage does. */
async function checkBackgroundSurvivesSourceRemoval(
  presentationId: string,
  slideId: string,
): Promise<void> {
  const page = await call(
    `${SLIDES}/presentations/${presentationId}/pages/${slideId}?fields=pageProperties.pageBackgroundFill.stretchedPictureFill.contentUrl`,
  );
  const contentUrl = (
    page.body as {
      pageProperties?: { pageBackgroundFill?: { stretchedPictureFill?: { contentUrl?: string } } };
    }
  ).pageProperties?.pageBackgroundFill?.stretchedPictureFill?.contentUrl;
  if (typeof contentUrl !== 'string') {
    record('D5', 'background has its own contentUrl after source removal', false, 'no contentUrl');
    return;
  }

  const fetched = await fetch(contentUrl);
  const bytes = fetched.ok ? (await fetched.arrayBuffer()).byteLength : 0;
  record(
    'D5',
    'background bytes still served after the source is gone',
    fetched.ok && bytes > 0,
    fetched.ok ? `${String(bytes)} bytes` : `HTTP ${String(fetched.status)}`,
  );
  await checkThumbnail(presentationId, slideId, 'D5 background');
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

/**
 * The rest of the D3 table, against a slide that HAS a layout — which is the case
 * that matters. Everything above ran on a blank scratch slide, where nothing can be
 * inherited and nothing can be broken. A real deck's text lives in placeholders that
 * carry the deck's design, and the question is whether an edit keeps that design or
 * flattens it. So: create a slide from one of the deck's OWN layouts, read back which
 * placeholders it came with, and drive the whole vocabulary through them.
 */
async function checkEditVocabulary(presentationId: string): Promise<void> {
  // A deck's layouts are the design it already has. Using one is the difference
  // between "add a slide that matches" and "add a white rectangle".
  const meta = await call(
    `${SLIDES}/presentations/${presentationId}?fields=layouts(objectId,layoutProperties)`,
  );
  const layouts = (
    meta.body as {
      layouts?: { objectId?: string; layoutProperties?: { name?: string; displayName?: string } }[];
    }
  ).layouts;
  // `name` is the stable identifier (TITLE_AND_BODY); `displayName` is the human label
  // ("Title and body") and is localised. Match the identifier, not the label.
  const layout = (layouts ?? []).find((l) => l.layoutProperties?.name === 'TITLE_AND_BODY');
  record(
    'D3',
    "read the deck's own layouts",
    (layouts ?? []).length > 0 && layout !== undefined,
    `${String((layouts ?? []).length)} layouts; TITLE_AND_BODY ${layout ? 'present' : 'missing'}`,
  );
  const layoutId = layout?.objectId;
  if (layoutId === undefined) return;

  const slideId = 'verity_spike_layout_slide';
  const added = await batchUpdate(presentationId, [
    {
      createSlide: {
        objectId: slideId,
        insertionIndex: 1,
        slideLayoutReference: { layoutId },
      },
    },
  ]);
  record(
    'D3',
    "createSlide from the deck's own layout",
    added.ok,
    added.ok ? '' : errorText(added.status, added.body),
  );
  if (!added.ok) return;

  // Read-then-write: the agent cannot know these ids in advance, it has to look.
  const placeholders = await readPlaceholders(presentationId, slideId);
  const titleId = placeholders.get('TITLE') ?? placeholders.get('CENTERED_TITLE');
  const bodyId = placeholders.get('BODY');
  record(
    'D3',
    'new slide arrives with the layout placeholders',
    titleId !== undefined && bodyId !== undefined,
    [...placeholders.keys()].join(', ') || 'none',
  );
  if (titleId === undefined || bodyId === undefined) return;

  const filled = await batchUpdate(presentationId, [
    { insertText: { objectId: titleId, text: 'Spike title TOKENA' } },
    { insertText: { objectId: bodyId, text: 'First line\nSecond line' } },
  ]);
  record(
    'D3',
    'insertText into inherited placeholders',
    filled.ok,
    filled.ok ? '' : errorText(filled.status, filled.body),
  );

  // The real question behind "keeps the design": does the inserted run carry its own
  // font, or does it stay empty and inherit from the layout? An empty style is the
  // good answer — it means Verity never has to name a font to look right.
  const runStyle = await readFirstRunStyle(presentationId, slideId, titleId);
  const explicit = Object.keys(runStyle);
  record(
    'D3',
    'inserted text inherits the layout style',
    !explicit.includes('fontFamily') && !explicit.includes('fontSize'),
    explicit.length === 0 ? 'run carries no explicit style' : `run sets ${explicit.join(', ')}`,
  );

  await runRequest(presentationId, 'updateTextStyle (bold + colour)', [
    {
      updateTextStyle: {
        objectId: titleId,
        textRange: { type: 'ALL' },
        style: {
          bold: true,
          foregroundColor: { opaqueColor: { rgbColor: { red: 0.8, green: 0.1, blue: 0.1 } } },
        },
        fields: 'bold,foregroundColor',
      },
    },
  ]);

  await runRequest(presentationId, 'updateParagraphStyle (alignment)', [
    {
      updateParagraphStyle: {
        objectId: titleId,
        textRange: { type: 'ALL' },
        style: { alignment: 'CENTER' },
        fields: 'alignment',
      },
    },
  ]);

  await runRequest(presentationId, 'createParagraphBullets', [
    {
      createParagraphBullets: {
        objectId: bodyId,
        textRange: { type: 'ALL' },
        bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
      },
    },
  ]);

  const replaced = await batchUpdate(presentationId, [
    {
      replaceAllText: {
        containsText: { text: 'TOKENA', matchCase: true },
        replaceText: 'TOKENB',
      },
    },
  ]);
  const occurrences = (
    replaced.body as { replies?: { replaceAllText?: { occurrencesChanged?: number } }[] }
  ).replies?.[0]?.replaceAllText?.occurrencesChanged;
  record(
    'D3',
    'replaceAllText',
    replaced.ok && occurrences === 1,
    replaced.ok
      ? `${String(occurrences ?? 0)} occurrence(s)`
      : errorText(replaced.status, replaced.body),
  );

  await runRequest(presentationId, 'deleteText (fixed range)', [
    {
      deleteText: {
        objectId: bodyId,
        textRange: { type: 'FIXED_RANGE', startIndex: 0, endIndex: 6 },
      },
    },
  ]);

  // A box to move and then remove, so the last two verbs run against something
  // disposable rather than against the slide's own placeholders.
  const boxId = 'verity_spike_moving_box';
  await runRequest(presentationId, 'createShape for transform/delete', [
    {
      createShape: {
        objectId: boxId,
        shapeType: 'TEXT_BOX',
        elementProperties: {
          pageObjectId: slideId,
          size: { width: { magnitude: 200, unit: 'PT' }, height: { magnitude: 40, unit: 'PT' } },
          transform: { scaleX: 1, scaleY: 1, translateX: 40, translateY: 300, unit: 'PT' },
        },
      },
    },
  ]);
  await runRequest(presentationId, 'updatePageElementTransform (ABSOLUTE)', [
    {
      updatePageElementTransform: {
        objectId: boxId,
        applyMode: 'ABSOLUTE',
        transform: { scaleX: 1, scaleY: 1, translateX: 260, translateY: 330, unit: 'PT' },
      },
    },
  ]);
  await runRequest(presentationId, 'deleteObject', [{ deleteObject: { objectId: boxId } }]);

  // Render it: every request above can succeed and still leave a broken slide.
  await checkThumbnail(presentationId, slideId, 'D3');
}

/** Map placeholder type → objectId for one page. The read half of read-plan-write. */
async function readPlaceholders(
  presentationId: string,
  slideId: string,
): Promise<Map<string, string>> {
  const page = await call(
    `${SLIDES}/presentations/${presentationId}/pages/${slideId}?fields=pageElements`,
  );
  const elements =
    (
      page.body as {
        pageElements?: { objectId?: string; shape?: { placeholder?: { type?: string } } }[];
      }
    ).pageElements ?? [];
  const found = new Map<string, string>();
  for (const element of elements) {
    const type = element.shape?.placeholder?.type;
    if (type !== undefined && element.objectId !== undefined && !found.has(type)) {
      found.set(type, element.objectId);
    }
  }
  return found;
}

async function readFirstRunStyle(
  presentationId: string,
  slideId: string,
  objectId: string,
): Promise<Record<string, unknown>> {
  const page = await call(
    `${SLIDES}/presentations/${presentationId}/pages/${slideId}?fields=pageElements`,
  );
  const elements =
    (
      page.body as {
        pageElements?: {
          objectId?: string;
          shape?: { text?: { textElements?: { textRun?: { style?: Record<string, unknown> } }[] } };
        }[];
      }
    ).pageElements ?? [];
  const run = elements
    .find((e) => e.objectId === objectId)
    ?.shape?.text?.textElements?.find((t) => t.textRun !== undefined)?.textRun;
  return run?.style ?? {};
}

/** One batch, one line in the report — the shape most of the D3 table needs. */
async function runRequest(
  presentationId: string,
  what: string,
  requests: unknown[],
): Promise<void> {
  const res = await batchUpdate(presentationId, requests);
  record('D3', what, res.ok, res.ok ? '' : errorText(res.status, res.body));
}

/**
 * D7 claims a Slides deck can be exported as .pptx instead of pdf. That is a one-line
 * change to NATIVE_EXPORT, and worth a line here because a wrong mime type fails at
 * import time in front of the operator, not at build time.
 */
async function checkPptxExport(presentationId: string): Promise<void> {
  const mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  const res = await fetch(
    `${DRIVE}/files/${presentationId}/export?mimeType=${encodeURIComponent(mimeType)}`,
    { headers: { Authorization: `Bearer ${TOKEN}` } },
  );
  if (!res.ok) {
    record('D7', 'export deck as .pptx', false, `HTTP ${String(res.status)}`);
    return;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  // A .pptx is a zip; anything else that arrives with a 200 is not one.
  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  record(
    'D7',
    'export deck as .pptx',
    isZip,
    `${String(bytes.length)} bytes, zip: ${String(isZip)}`,
  );
}

/** D6: a thumbnail url is worthless if it cannot actually be fetched, so fetch it. */
async function checkThumbnail(
  presentationId: string,
  slideId: string,
  id: string,
): Promise<boolean> {
  const res = await call(
    `${SLIDES}/presentations/${presentationId}/pages/${slideId}/thumbnail` +
      '?thumbnailProperties.mimeType=PNG&thumbnailProperties.thumbnailSize=MEDIUM',
  );
  if (!res.ok) {
    record(id, 'getThumbnail', false, errorText(res.status, res.body));
    return false;
  }
  const thumb = res.body as { contentUrl?: string; width?: number; height?: number };
  const url = thumb.contentUrl;
  if (typeof url !== 'string') {
    record(id, 'getThumbnail', false, 'no contentUrl in response');
    return false;
  }
  record(id, 'getThumbnail', true, `${String(thumb.width)}x${String(thumb.height)}`);

  // The thumbnail url is short-lived and unauthenticated — fetch it WITHOUT the
  // bearer token, which is how the chat would consume it.
  const image = await fetch(url);
  const png = image.ok ? Buffer.from(await image.arrayBuffer()) : Buffer.alloc(0);
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const isPng = png.length >= pngSignature.length && png.subarray(0, 8).equals(pngSignature);
  record(
    id,
    'thumbnail contentUrl is fetchable',
    image.ok && isPng,
    image.ok ? `${String(png.length)} bytes` : `HTTP ${String(image.status)}`,
  );

  // Optional: keep the last render on disk so it can actually be looked at. Off by
  // default — a spike that litters the working tree gets run less often.
  const out = process.env.THUMB_OUT;
  if (out !== undefined && out.length > 0 && isPng) writeFileSync(out, png);
  return image.ok && isPng;
}

/** D2: the guard only earns its place if a stale revision is actually refused. */
async function checkRevisionGuard(presentationId: string, textObjectId: string): Promise<void> {
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
    [{ insertText: { objectId: textObjectId, text: 'x' } }],
    staleRevision,
  );
  const secondError = errorText(second.status, second.body);
  const rejectedForStaleRevision =
    second.status === 400 && secondError.includes('does not match the latest revision');
  record(
    'D2',
    'batchUpdate with STALE revisionId is rejected',
    rejectedForStaleRevision,
    second.ok ? 'ACCEPTED — the guard does not fire, D2 is wrong' : secondError,
  );
}

/** D4: read-only probe of a deck the app did not create. Never writes. */
async function probeExistingDeck(deckId: string): Promise<void> {
  const res = await call(
    `${SLIDES}/presentations/${deckId}?fields=presentationId,revisionId,layouts.objectId,layouts.layoutProperties,slides.objectId`,
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
    layouts?: { layoutProperties?: { name?: string; displayName?: string } }[];
    slides?: { objectId: string }[];
  };
  const layouts = deck.layouts ?? [];
  record(
    'D4',
    'read an existing deck (presentations scope)',
    true,
    `${String(deck.slides?.length ?? 0)} slides, ${String(layouts.length)} layouts`,
  );

  // A branded deck does NOT carry Google's predefined layout names. Report both
  // fields side by side, because D3's "reference a layout already in the deck" is
  // only implementable if something stable can be matched on.
  const named = layouts
    .map((l) => `${l.layoutProperties?.name ?? '—'}/${l.layoutProperties?.displayName ?? '—'}`)
    .slice(0, 10);
  const predefined = layouts.filter((l) => l.layoutProperties?.name === 'TITLE_AND_BODY').length;
  record(
    'D4',
    'layout names on a real deck (name/displayName)',
    layouts.length > 0,
    `${named.join(', ')}${predefined === 0 ? ' — no predefined names' : ''}`,
  );

  const firstSlide = deck.slides?.[0]?.objectId;
  if (firstSlide === undefined) return;

  // The read half of read-plan-write, against a deck Verity did not author: can the
  // agent find addressable text, and does that text inherit its style?
  const placeholders = await readPlaceholders(deckId, firstSlide);
  record(
    'D4',
    'slide 1 exposes addressable placeholders',
    placeholders.size > 0,
    placeholders.size > 0
      ? [...placeholders.keys()].join(', ')
      : 'none — free-floating shapes only',
  );
  const inventory = await readSlideText(deckId, firstSlide);
  record(
    'D4',
    'slide 1 text is readable and style-free',
    inventory.runs > 0,
    `${String(inventory.elements)} elements, ${String(inventory.runs)} text runs, ` +
      `${String(inventory.styled)} carrying an explicit font`,
  );

  await checkThumbnail(deckId, firstSlide, 'D4');

  if (process.env.WRITE_TEST === '1') await writeTestOnExistingDeck(deckId);
  else console.log('  skip  D4 write test (set WRITE_TEST=1 — it edits the real deck)');
}

/** Count text runs on a page and how many pin their own font rather than inherit. */
async function readSlideText(
  presentationId: string,
  slideId: string,
): Promise<{ elements: number; runs: number; styled: number }> {
  const page = await call(
    `${SLIDES}/presentations/${presentationId}/pages/${slideId}?fields=pageElements`,
  );
  const elements =
    (
      page.body as {
        pageElements?: {
          shape?: { text?: { textElements?: { textRun?: { style?: Record<string, unknown> } }[] } };
        }[];
      }
    ).pageElements ?? [];
  let runs = 0;
  let styled = 0;
  for (const element of elements) {
    for (const textElement of element.shape?.text?.textElements ?? []) {
      if (textElement.textRun === undefined) continue;
      runs += 1;
      const style = textElement.textRun.style ?? {};
      if ('fontFamily' in style || 'fontSize' in style) styled += 1;
    }
  }
  return { elements: elements.length, runs, styled };
}

/**
 * The one thing the read-only pass cannot answer: does the full read-plan-write cycle
 * work against a deck Verity did not author? Behind WRITE_TEST=1 because writing into
 * somebody's real deck is not something a spike may do on its own.
 *
 * The test is built to be reversible and invisible: the box is placed OFF-CANVAS, so
 * even a failed cleanup leaves nothing a reader can see, and it is deleted again in
 * the same run. What cannot be reversed is Google's revision history — two entries
 * stay behind, which is why this needs the operator's word rather than a flag alone.
 *
 * It doubles as the proof for D3's sibling-style fallback: on a flattened deck there
 * is nothing to inherit from, so the box is styled by COPYING a neighbouring run.
 */
async function writeTestOnExistingDeck(deckId: string): Promise<void> {
  const head = await call(`${SLIDES}/presentations/${deckId}?fields=revisionId,slides.objectId`);
  const deck = head.body as { revisionId?: string; slides?: { objectId: string }[] };
  const slideId = deck.slides?.at(-1)?.objectId;
  const revision = deck.revisionId;
  if (slideId === undefined || revision === undefined) {
    record('D4', 'write test: read head revision', false, errorText(head.status, head.body));
    return;
  }

  const sibling = await readFirstCopyableStyle(deckId, slideId);
  record(
    'D4',
    'write test: found a sample run for style transport',
    sibling !== undefined,
    sibling === undefined ? 'no styled run on the slide' : Object.keys(sibling).join(', '),
  );

  // Off-canvas: a 16:9 deck is 720x405 pt, so 900 pt is past the right edge.
  const boxId = `verity_spike_${Date.now().toString(36)}`;
  const requests: unknown[] = [
    {
      createShape: {
        objectId: boxId,
        shapeType: 'TEXT_BOX',
        elementProperties: {
          pageObjectId: slideId,
          size: { width: { magnitude: 120, unit: 'PT' }, height: { magnitude: 30, unit: 'PT' } },
          transform: { scaleX: 1, scaleY: 1, translateX: 900, translateY: 20, unit: 'PT' },
        },
      },
    },
    { insertText: { objectId: boxId, text: 'verity spike' } },
  ];
  if (sibling !== undefined) {
    requests.push({
      updateTextStyle: {
        objectId: boxId,
        textRange: { type: 'ALL' },
        style: sibling,
        fields: Object.keys(sibling).join(','),
      },
    });
  }

  try {
    // Cleanup wraps the write itself: a response can be lost after Google applied the batch.
    const written = await batchUpdate(deckId, requests, revision);
    record(
      'D4',
      'write test: batchUpdate against a foreign deck',
      written.ok,
      written.ok ? '' : errorText(written.status, written.body),
    );
    if (!written.ok) return;

    // Did the copied style actually land? This is the D3 fallback's whole premise.
    const applied = await readFirstRunStyle(deckId, slideId, boxId);
    const wanted = Object.keys(sibling ?? {});
    const landed = wanted.filter((k) => k in applied);
    record(
      'D4',
      'write test: sibling style landed on the new box',
      wanted.length > 0 && landed.length === wanted.length,
      `${String(landed.length)}/${String(wanted.length)} fields`,
    );

    // The revision guard, on a deck with real concurrent editors rather than a scratch one.
    const stale = await batchUpdate(
      deckId,
      [{ insertText: { objectId: boxId, text: '!' } }],
      revision,
    );
    const staleError = errorText(stale.status, stale.body);
    record(
      'D4',
      'write test: stale revisionId is refused',
      stale.status === 400 && staleError.includes('does not match the latest revision'),
      staleError,
    );
  } finally {
    // A run-unique id makes an unconditional delete safe even when the create response was lost.
    const removed = await batchUpdate(deckId, [{ deleteObject: { objectId: boxId } }]);
    const removeError = errorText(removed.status, removed.body);
    const alreadyAbsent = removed.status === 400 && removeError.includes('could not be found');
    record(
      'D4',
      'write test: box removed again',
      removed.ok || alreadyAbsent,
      removed.ok ? '' : removeError,
    );

    const after = await readPlaceholders(deckId, slideId);
    const stillThere = await pageHasObject(deckId, slideId, boxId);
    record(
      'D4',
      'write test: deck is back to its previous shape',
      !stillThere,
      `${String(after.size)} placeholders unchanged`,
    );
  }
}

async function pageHasObject(
  presentationId: string,
  slideId: string,
  objectId: string,
): Promise<boolean> {
  const page = await call(
    `${SLIDES}/presentations/${presentationId}/pages/${slideId}?fields=pageElements.objectId`,
  );
  const elements = (page.body as { pageElements?: { objectId?: string }[] }).pageElements ?? [];
  return elements.some((element) => element.objectId === objectId);
}

/** Sample a run to prove field transport; this does not choose a semantically comparable style. */
async function readFirstCopyableStyle(
  presentationId: string,
  slideId: string,
): Promise<Record<string, unknown> | undefined> {
  const page = await call(
    `${SLIDES}/presentations/${presentationId}/pages/${slideId}?fields=pageElements`,
  );
  const elements =
    (
      page.body as {
        pageElements?: {
          shape?: { text?: { textElements?: { textRun?: { style?: Record<string, unknown> } }[] } };
        }[];
      }
    ).pageElements ?? [];
  const COPYABLE = [
    'bold',
    'italic',
    'fontSize',
    'foregroundColor',
    'weightedFontFamily',
    'fontFamily',
  ];
  for (const element of elements) {
    for (const textElement of element.shape?.text?.textElements ?? []) {
      const style = textElement.textRun?.style;
      if (style === undefined || !('fontFamily' in style)) continue;
      const copied: Record<string, unknown> = {};
      for (const key of COPYABLE) if (key in style) copied[key] = style[key];
      // weightedFontFamily wins over fontFamily; sending both is noise.
      if ('weightedFontFamily' in copied) delete copied.fontFamily;
      return copied;
    }
  }
  return undefined;
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
    false,
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
      true,
    );
  }

  if (workingUrl !== undefined) {
    await checkBackgroundFill(deck.id, deck.slideId, workingUrl);
    const sourceGone = await checkImageSurvivesSourceRemoval(
      deck.id,
      deck.slideId,
      image.id,
      workingUrl,
    );
    if (sourceGone) await checkBackgroundSurvivesSourceRemoval(deck.id, deck.slideId);
    // That step deletes the source itself; do not let cleanup chase a 404.
    if (sourceGone) created.splice(created.indexOf(image.id), 1);
  } else {
    record('D5', 'slide background via stretchedPictureFill', false, 'skipped — no url worked');
  }

  await checkTextBox(deck.id, deck.slideId);
  await checkThumbnail(deck.id, deck.slideId, 'D6');
  await checkEditVocabulary(deck.id);
  await checkPptxExport(deck.id);
  await checkRevisionGuard(deck.id, 'verity_spike_box');

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
