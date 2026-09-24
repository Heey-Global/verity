const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_BODY_CHARS = 100_000;

class GmailError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GmailError';
  }
}

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

type FetchLike = typeof fetch;

async function gmailJson<T>(
  path: string,
  accessToken: string,
  init: RequestInit = {},
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  const response = await fetchImpl(`${GMAIL_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw new GmailError(`Gmail request failed (HTTP ${String(response.status)})`, response.status);
  }
  return (await response.json()) as T;
}

function header(part: GmailPart | undefined, name: string): string | undefined {
  return part?.headers?.find((candidate) => candidate.name?.toLowerCase() === name)?.value;
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function messageBodies(
  part: GmailPart | undefined,
  maxChars = MAX_BODY_CHARS,
): { text?: string; html?: string } {
  const bodies: { text?: string; html?: string } = {};
  const visit = (candidate: GmailPart | undefined): void => {
    if (candidate === undefined) return;
    if (candidate.filename === '' || candidate.filename === undefined) {
      const data = candidate.body?.data;
      if (data !== undefined && candidate.mimeType === 'text/plain' && bodies.text === undefined) {
        bodies.text = decodeBase64Url(data).slice(0, maxChars);
      } else if (
        data !== undefined &&
        candidate.mimeType === 'text/html' &&
        bodies.html === undefined
      ) {
        bodies.html = decodeBase64Url(data).slice(0, maxChars);
      }
    }
    candidate.parts?.forEach(visit);
  };
  visit(part);
  return bodies;
}

function normalizeMessage(message: GmailMessage): Record<string, unknown> {
  const payload = message.payload;
  const attachments: { filename: string; mimeType?: string; size?: number }[] = [];
  const collectAttachments = (part: GmailPart | undefined): void => {
    if (part === undefined) return;
    if (part.filename !== undefined && part.filename.length > 0) {
      attachments.push({
        filename: part.filename,
        ...(part.mimeType === undefined ? {} : { mimeType: part.mimeType }),
        ...(part.body?.size === undefined ? {} : { size: part.body.size }),
      });
    }
    part.parts?.forEach(collectAttachments);
  };
  collectAttachments(payload);
  return {
    id: message.id,
    threadId: message.threadId,
    labelIds: message.labelIds ?? [],
    snippet: message.snippet ?? '',
    ...(message.internalDate === undefined
      ? {}
      : { internalDate: new Date(Number(message.internalDate)).toISOString() }),
    headers: {
      from: header(payload, 'from'),
      replyTo: header(payload, 'reply-to'),
      to: header(payload, 'to'),
      cc: header(payload, 'cc'),
      subject: header(payload, 'subject'),
      date: header(payload, 'date'),
      messageId: header(payload, 'message-id'),
      inReplyTo: header(payload, 'in-reply-to'),
      references: header(payload, 'references'),
    },
    ...messageBodies(payload),
    attachments,
  };
}

export async function searchGmail(
  accessToken: string,
  query: string,
  maxResults: number,
  pageToken?: string,
  fetchImpl: FetchLike = fetch,
): Promise<unknown> {
  const search = new URLSearchParams({ q: query, maxResults: String(maxResults) });
  if (pageToken !== undefined) search.set('pageToken', pageToken);
  const result = await gmailJson<{
    messages?: { id?: string; threadId?: string }[];
    nextPageToken?: string;
    resultSizeEstimate?: number;
  }>(`/messages?${search.toString()}`, accessToken, {}, fetchImpl);
  const messages = await Promise.all(
    (result.messages ?? []).flatMap((message) =>
      message.id === undefined
        ? []
        : [
            gmailJson<GmailMessage>(
              `/messages/${encodeURIComponent(message.id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
              accessToken,
              {},
              fetchImpl,
            ).then(normalizeMessage),
          ],
    ),
  );
  return {
    messages,
    resultSizeEstimate: result.resultSizeEstimate ?? messages.length,
    ...(result.nextPageToken === undefined ? {} : { nextPageToken: result.nextPageToken }),
  };
}

export async function readGmailThread(
  accessToken: string,
  threadId: string,
  fetchImpl: FetchLike = fetch,
): Promise<unknown> {
  const thread = await gmailJson<{ id?: string; historyId?: string; messages?: GmailMessage[] }>(
    `/threads/${encodeURIComponent(threadId)}?format=full`,
    accessToken,
    {},
    fetchImpl,
  );
  return {
    id: thread.id,
    historyId: thread.historyId,
    messages: (thread.messages ?? []).map(normalizeMessage),
  };
}

export async function createGmailReplyDraft(
  accessToken: string,
  input: { threadId: string; messageId?: string; body: string; htmlBody?: string },
  fetchImpl: FetchLike = fetch,
): Promise<unknown> {
  const thread = await gmailJson<{ messages?: GmailMessage[] }>(
    `/threads/${encodeURIComponent(input.threadId)}?format=full`,
    accessToken,
    {},
    fetchImpl,
  );
  const messages = thread.messages ?? [];
  const target = input.messageId
    ? messages.find((message) => message.id === input.messageId)
    : (messages.findLast(
        (message) => !message.labelIds?.includes('SENT') && !message.labelIds?.includes('DRAFT'),
      ) ?? messages.findLast((message) => !message.labelIds?.includes('DRAFT')));
  if (target === undefined) {
    throw new Error(
      input.messageId === undefined
        ? 'The Gmail thread contains no messages to reply to'
        : 'The requested Gmail message is not in this thread',
    );
  }
  const recipient = target.labelIds?.includes('SENT')
    ? header(target.payload, 'to')
    : (header(target.payload, 'reply-to') ?? header(target.payload, 'from'));
  const messageId = header(target.payload, 'message-id');
  if (recipient === undefined || messageId === undefined) {
    throw new Error('The Gmail message is missing reply headers');
  }
  const existingReferences = header(target.payload, 'references');
  const subject = decodeMimeHeader(header(target.payload, 'subject') ?? '');
  return createGmailDraft(
    accessToken,
    {
      to: [recipient],
      subject: /^re:/iu.test(subject) ? subject : `Re: ${subject}`,
      body: input.body,
      ...(input.htmlBody === undefined ? {} : { htmlBody: input.htmlBody }),
      threadId: input.threadId,
      inReplyTo: messageId,
      references:
        existingReferences === undefined ? messageId : `${existingReferences} ${messageId}`,
    },
    fetchImpl,
  );
}

function safeHeader(value: string, field: string): string {
  if (/\r|\n/u.test(value)) throw new Error(`${field} contains a line break`);
  return value;
}

function mimeHeader(value: string, field: string): string {
  const safe = safeHeader(value, field);
  if (/^[\x20-\x7e]*$/u.test(safe) && !/=\?[^?]+\?[bq]\?[^?]*\?=/iu.test(safe)) return safe;
  const chunks: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const character of safe) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > 45 && chunk !== '') {
      chunks.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk !== '') chunks.push(chunk);
  return chunks
    .map((part) => `=?UTF-8?B?${Buffer.from(part, 'utf8').toString('base64')}?=`)
    .join('\r\n ');
}

function decodeMimeHeader(value: string): string {
  const encodedWord = /=\?([^?]+)\?([bq])\?([^?]*)\?=/giu;
  let decoded = '';
  let cursor = 0;
  let previousWasEncoded = false;
  for (const match of value.matchAll(encodedWord)) {
    const index = match.index;
    const gap = value.slice(cursor, index);
    if (!(previousWasEncoded && /^\s*$/u.test(gap))) decoded += gap;
    const charset = match[1]?.toLowerCase();
    const encoding = match[2]?.toLowerCase();
    const payload = match[3] ?? '';
    const bytes =
      encoding === 'b'
        ? Buffer.from(payload, 'base64')
        : Buffer.from(
            payload
              .replace(/_/gu, ' ')
              .replace(/=([0-9a-f]{2})/giu, (_, hex: string) =>
                String.fromCharCode(Number.parseInt(hex, 16)),
              ),
            'latin1',
          );
    try {
      decoded += new TextDecoder(charset, { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`Unsupported Gmail subject character set: ${charset ?? 'unknown'}`);
    }
    cursor = index + match[0].length;
    previousWasEncoded = true;
  }
  decoded += value.slice(cursor);
  return decoded;
}

export interface GmailDraftInput {
  from?: string;
  replyTo?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  htmlBody?: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
}

const EMAIL_HTML_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'a',
    'b',
    'blockquote',
    'br',
    'div',
    'em',
    'font',
    'hr',
    'i',
    'img',
    'li',
    'ol',
    'p',
    'span',
    'strong',
    'table',
    'tbody',
    'td',
    'th',
    'thead',
    'tr',
    'u',
    'ul',
  ],
  allowedAttributes: {
    a: ['href', 'title'],
    font: ['color', 'face', 'size'],
    img: ['alt', 'height', 'src', 'title', 'width'],
    table: ['border', 'cellpadding', 'cellspacing'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan'],
  },
  allowedSchemes: ['cid', 'http', 'https', 'mailto'],
  allowProtocolRelative: false,
};

function sanitizeGmailHtml(html: string): string {
  return sanitizeHtml(html, EMAIL_HTML_OPTIONS);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

function emailHtml(body: string, signatureHtml: string): string {
  const message = escapeHtml(body).replace(/\r?\n/gu, '<br>');
  return sanitizeGmailHtml(
    signatureHtml.trim() === ''
      ? `<div>${message}</div>`
      : `<div>${message}</div><br>${signatureHtml}`,
  );
}

function gmailHtmlExternalUrls(html: string): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/giu)) {
    if (match[1] === undefined) continue;
    const value = match[1].replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z]+);/giu, (_, entity: string) =>
      decodeHtmlEntity(entity),
    );
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' || url.protocol === 'https:') urls.add(url.href);
    } catch {
      // Relative and malformed values cannot identify an external resource.
    }
  }
  return [...urls];
}

function decodeHtmlEntity(entity: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  if (entity.startsWith('#x') || entity.startsWith('#X')) {
    const point = Number.parseInt(entity.slice(2), 16);
    return Number.isFinite(point) ? String.fromCodePoint(point) : `&${entity};`;
  }
  if (entity.startsWith('#')) {
    const point = Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(point) ? String.fromCodePoint(point) : `&${entity};`;
  }
  return named[entity.toLowerCase()] ?? `&${entity};`;
}

function gmailSignatureText(html: string): string {
  let text = sanitizeHtml(html, {
    allowedTags: ['br', 'div', 'li', 'p', 'table', 'tr'],
    allowedAttributes: {},
    transformTags: {
      img: (_tagName, attributes) => ({
        tagName: 'span',
        attribs: {},
        text: attributes['alt'] ?? '',
      }),
    },
  });
  text = text.replaceAll('<br />', '\n').replaceAll('<li>', '• ');
  for (const tag of ['div', 'li', 'p', 'table', 'tr']) {
    text = text.replaceAll(`<${tag}>`, '').replaceAll(`</${tag}>`, '\n');
  }
  return text
    .replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z]+);/giu, (_, entity: string) =>
      decodeHtmlEntity(entity),
    )
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function appendGmailSignatureText(body: string, signature: string): string {
  const normalized = signature.trim();
  if (normalized === '' || body.trimEnd().endsWith(normalized)) return body;
  return `${body.trimEnd()}\n\n${normalized}`;
}

export interface GmailSignature {
  text: string;
  html: string;
  externalUrls: string[];
}

export function appendGmailSignature(
  body: string,
  signature: GmailSignature,
): { body: string; htmlBody: string } {
  const normalizedText = signature.text.trim();
  const alreadySigned = normalizedText !== '' && body.trimEnd().endsWith(normalizedText);
  return {
    body: appendGmailSignatureText(body, signature.text),
    htmlBody: emailHtml(body, alreadySigned ? '' : signature.html),
  };
}

export async function readGmailSignature(
  accessToken: string,
  accountEmail: string,
  fetchImpl: FetchLike = fetch,
): Promise<GmailSignature> {
  const sendAs = await gmailJson<{ signature?: unknown }>(
    `/settings/sendAs/${encodeURIComponent(accountEmail)}`,
    accessToken,
    {},
    fetchImpl,
  );
  const html = typeof sendAs.signature === 'string' ? sanitizeGmailHtml(sendAs.signature) : '';
  return { text: gmailSignatureText(html), html, externalUrls: gmailHtmlExternalUrls(html) };
}

function rawMessage(input: GmailDraftInput): string {
  const headers = [
    ...(input.from === undefined ? [] : [`From: ${safeHeader(input.from, 'from')}`]),
    ...(input.replyTo === undefined ? [] : [`Reply-To: ${safeHeader(input.replyTo, 'replyTo')}`]),
    `To: ${input.to.map((value) => safeHeader(value, 'to')).join(', ')}`,
    ...(input.cc === undefined || input.cc.length === 0
      ? []
      : [`Cc: ${input.cc.map((value) => safeHeader(value, 'cc')).join(', ')}`]),
    ...(input.bcc === undefined || input.bcc.length === 0
      ? []
      : [`Bcc: ${input.bcc.map((value) => safeHeader(value, 'bcc')).join(', ')}`]),
    `Subject: ${mimeHeader(input.subject, 'subject')}`,
    ...(input.inReplyTo === undefined
      ? []
      : [`In-Reply-To: ${safeHeader(input.inReplyTo, 'inReplyTo')}`]),
    ...(input.references === undefined
      ? []
      : [`References: ${safeHeader(input.references, 'references')}`]),
    'MIME-Version: 1.0',
  ];
  if (input.htmlBody === undefined) {
    headers.push(
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      input.body.replace(/\r?\n/gu, '\r\n'),
    );
  } else {
    const boundary = `verity_${createHash('sha256')
      .update(input.body)
      .update('\0')
      .update(input.htmlBody)
      .digest('hex')
      .slice(0, 32)}`;
    const encodePart = (value: string): string =>
      Buffer.from(value, 'utf8')
        .toString('base64')
        .match(/.{1,76}/gu)
        ?.join('\r\n') ?? '';
    headers.push(
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      encodePart(input.body.replace(/\r?\n/gu, '\r\n')),
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      encodePart(input.htmlBody),
      `--${boundary}--`,
      '',
    );
  }
  return Buffer.from(headers.join('\r\n'), 'utf8').toString('base64url');
}

export async function createGmailDraft(
  accessToken: string,
  input: GmailDraftInput,
  fetchImpl: FetchLike = fetch,
): Promise<unknown> {
  const raw = rawMessage(input);
  const draft = await gmailJson<{ id?: string; message?: GmailMessage }>(
    '/drafts',
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({
        message: { raw, ...(input.threadId ? { threadId: input.threadId } : {}) },
      }),
    },
    fetchImpl,
  );
  return { id: draft.id, messageId: draft.message?.id, threadId: draft.message?.threadId };
}

export interface GmailDraftSendSnapshot {
  draftId: string;
  messageId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  from?: string;
  replyTo?: string;
  htmlBody?: string;
  externalUrls: string[];
  threadId?: string;
  inReplyTo?: string;
  references?: string;
}

export function assertSafeGmailSendSnapshot(snapshot: GmailDraftSendSnapshot): void {
  const expectedUrls =
    snapshot.htmlBody === undefined ? [] : gmailHtmlExternalUrls(snapshot.htmlBody);
  if (
    (snapshot.htmlBody !== undefined &&
      sanitizeGmailHtml(snapshot.htmlBody) !== snapshot.htmlBody) ||
    JSON.stringify(expectedUrls) !== JSON.stringify(snapshot.externalUrls)
  ) {
    throw new Error('The Gmail HTML preview does not match the message to send');
  }
}

function addressList(value: string | undefined): string[] {
  if (value === undefined) return [];
  const addresses: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  let angleDepth = 0;
  let commentDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quoted) {
      escaped = true;
      continue;
    }
    if (character === '"' && commentDepth === 0) {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (character === '(') commentDepth += 1;
    else if (character === ')' && commentDepth > 0) commentDepth -= 1;
    else if (commentDepth === 0 && character === '<') angleDepth += 1;
    else if (commentDepth === 0 && character === '>' && angleDepth > 0) angleDepth -= 1;
    else if (character === ',' && commentDepth === 0 && angleDepth === 0) {
      const address = value.slice(start, index).trim();
      if (address !== '') addresses.push(address);
      start = index + 1;
    }
  }
  const finalAddress = value.slice(start).trim();
  if (finalAddress !== '') addresses.push(finalAddress);
  return addresses;
}

function utf8DraftPartBody(payload: GmailPart): string {
  const contentType = header(payload, 'content-type');
  const charset = contentType?.match(/\bcharset\s*=\s*"?([^;"\s]+)/iu)?.[1]?.toLowerCase();
  if (charset !== undefined && charset !== 'utf-8' && charset !== 'us-ascii') {
    throw new Error(`Unsupported Gmail draft character set: ${charset}`);
  }
  const data = payload.body?.data;
  if (data === undefined) throw new Error('The Gmail draft part has no body');
  return new TextDecoder(charset ?? 'utf-8', { fatal: true }).decode(
    Buffer.from(data, 'base64url'),
  );
}

export async function readGmailDraftForSend(
  accessToken: string,
  draftId: string,
  fetchImpl: FetchLike = fetch,
): Promise<GmailDraftSendSnapshot> {
  const draft = await gmailJson<{ id?: string; message?: GmailMessage }>(
    `/drafts/${encodeURIComponent(draftId)}?format=full`,
    accessToken,
    {},
    fetchImpl,
  );
  const message = draft.message;
  if (draft.id === undefined || message?.id === undefined) {
    throw new Error('The Gmail draft is missing its identity');
  }
  const payload = message.payload;
  if (payload === undefined || (payload.filename !== undefined && payload.filename !== '')) {
    throw new Error('Gmail drafts with attachments cannot be sent');
  }
  let body: string;
  let htmlBody: string | undefined;
  if (payload.mimeType === 'text/plain' && (payload.parts?.length ?? 0) === 0) {
    body = utf8DraftPartBody(payload);
  } else if (payload.mimeType === 'multipart/alternative' && payload.parts?.length === 2) {
    const plain = payload.parts.find((part) => part.mimeType === 'text/plain');
    const html = payload.parts.find((part) => part.mimeType === 'text/html');
    if (
      plain === undefined ||
      html === undefined ||
      (plain.parts?.length ?? 0) > 0 ||
      (html.parts?.length ?? 0) > 0 ||
      (plain.filename !== undefined && plain.filename !== '') ||
      (html.filename !== undefined && html.filename !== '')
    ) {
      throw new Error('The Gmail draft contains unsupported MIME content');
    }
    body = utf8DraftPartBody(plain);
    htmlBody = sanitizeGmailHtml(utf8DraftPartBody(html));
  } else {
    throw new Error('The Gmail draft contains unsupported MIME content');
  }
  const inReplyTo = header(message.payload, 'in-reply-to');
  const references = header(message.payload, 'references');
  const from = header(message.payload, 'from');
  const replyTo = header(message.payload, 'reply-to');
  return {
    draftId: draft.id,
    messageId: message.id,
    to: addressList(header(message.payload, 'to')),
    cc: addressList(header(message.payload, 'cc')),
    bcc: addressList(header(message.payload, 'bcc')),
    subject: decodeMimeHeader(header(message.payload, 'subject') ?? ''),
    body,
    ...(from === undefined ? {} : { from }),
    ...(replyTo === undefined ? {} : { replyTo }),
    ...(htmlBody === undefined ? {} : { htmlBody }),
    externalUrls: htmlBody === undefined ? [] : gmailHtmlExternalUrls(htmlBody),
    ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
    ...(references === undefined ? {} : { references }),
  };
}

export async function sendGmailDraft(
  accessToken: string,
  approved: GmailDraftSendSnapshot,
  fetchImpl: FetchLike = fetch,
): Promise<unknown> {
  assertSafeGmailSendSnapshot(approved);
  const raw = rawMessage({
    to: approved.to,
    cc: approved.cc,
    bcc: approved.bcc,
    subject: approved.subject,
    body: approved.body,
    ...(approved.from === undefined ? {} : { from: approved.from }),
    ...(approved.replyTo === undefined ? {} : { replyTo: approved.replyTo }),
    ...(approved.htmlBody === undefined ? {} : { htmlBody: approved.htmlBody }),
    ...(approved.threadId === undefined ? {} : { threadId: approved.threadId }),
    ...(approved.inReplyTo === undefined ? {} : { inReplyTo: approved.inReplyTo }),
    ...(approved.references === undefined ? {} : { references: approved.references }),
  });
  const sent = await gmailJson<GmailMessage>(
    '/messages/send',
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({
        raw,
        ...(approved.threadId === undefined ? {} : { threadId: approved.threadId }),
      }),
    },
    fetchImpl,
  );
  return { messageId: sent.id, threadId: sent.threadId, draftRetained: true };
}
import { createHash } from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
