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

function messageBodies(part: GmailPart | undefined): { text?: string; html?: string } {
  const bodies: { text?: string; html?: string } = {};
  const visit = (candidate: GmailPart | undefined): void => {
    if (candidate === undefined) return;
    if (candidate.filename === '' || candidate.filename === undefined) {
      const data = candidate.body?.data;
      if (data !== undefined && candidate.mimeType === 'text/plain' && bodies.text === undefined) {
        bodies.text = decodeBase64Url(data).slice(0, MAX_BODY_CHARS);
      } else if (
        data !== undefined &&
        candidate.mimeType === 'text/html' &&
        bodies.html === undefined
      ) {
        bodies.html = decodeBase64Url(data).slice(0, MAX_BODY_CHARS);
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
  input: { threadId: string; messageId?: string; body: string },
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
      ) ?? messages.at(-1));
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
  const subject = header(target.payload, 'subject') ?? '';
  return createGmailDraft(
    accessToken,
    {
      to: [recipient],
      subject: /^re:/iu.test(subject) ? subject : `Re: ${subject}`,
      body: input.body,
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

export interface GmailDraftInput {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
}

export async function createGmailDraft(
  accessToken: string,
  input: GmailDraftInput,
  fetchImpl: FetchLike = fetch,
): Promise<unknown> {
  const lines = [
    `To: ${input.to.map((value) => safeHeader(value, 'to')).join(', ')}`,
    ...(input.cc === undefined || input.cc.length === 0
      ? []
      : [`Cc: ${input.cc.map((value) => safeHeader(value, 'cc')).join(', ')}`]),
    `Subject: ${safeHeader(input.subject, 'subject')}`,
    ...(input.inReplyTo === undefined
      ? []
      : [`In-Reply-To: ${safeHeader(input.inReplyTo, 'inReplyTo')}`]),
    ...(input.references === undefined
      ? []
      : [`References: ${safeHeader(input.references, 'references')}`]),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    input.body.replace(/\r?\n/gu, '\r\n'),
  ];
  const raw = Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
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
