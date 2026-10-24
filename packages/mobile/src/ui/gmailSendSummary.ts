export interface GmailSendAttachment {
  filename: string;
  mimeType: string;
  size: number;
}

export interface GmailSendSummary {
  draftId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  from: string | null;
  replyTo: string | null;
  htmlBody: string | null;
  externalUrls: string[];
  attachments: GmailSendAttachment[];
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

function attachmentList(value: unknown): GmailSendAttachment[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const attachments: GmailSendAttachment[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null) return null;
    const { filename, mimeType, size } = item as Record<string, unknown>;
    if (
      typeof filename !== 'string' ||
      typeof mimeType !== 'string' ||
      typeof size !== 'number' ||
      !Number.isInteger(size) ||
      size < 0
    )
      return null;
    attachments.push({ filename, mimeType, size });
  }
  return attachments;
}

/** Human-readable byte size for the approval card. */
export function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function gmailSendSummary(input: unknown): GmailSendSummary | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (
    value['action'] !== 'send_draft' ||
    typeof value['draftId'] !== 'string' ||
    typeof value['subject'] !== 'string' ||
    typeof value['body'] !== 'string'
  )
    return null;
  const to = strings(value['to']);
  const cc = strings(value['cc']);
  const bcc = strings(value['bcc']);
  const externalUrls = strings(value['externalUrls']);
  const htmlBody = value['htmlBody'];
  // Unreadable attachment metadata must not yield a card that silently omits a file.
  const attachments = attachmentList(value['attachments']);
  if (
    attachments === null ||
    to === null ||
    to.length === 0 ||
    cc === null ||
    bcc === null ||
    externalUrls === null ||
    (htmlBody !== undefined && typeof htmlBody !== 'string')
  )
    return null;
  return {
    draftId: value['draftId'],
    to,
    cc,
    bcc,
    subject: value['subject'],
    body: value['body'],
    from: typeof value['from'] === 'string' ? value['from'] : null,
    replyTo: typeof value['replyTo'] === 'string' ? value['replyTo'] : null,
    htmlBody: typeof htmlBody === 'string' ? htmlBody : null,
    externalUrls,
    attachments,
  };
}

export function gmailPreviewHtml(html: string): string {
  // The gateway supplies the server's allowlist-sanitized snapshot. The WebView disables
  // JavaScript and navigation, while this policy prevents every remote resource from loading.
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{font-family:-apple-system,system-ui,sans-serif;font-size:15px;line-height:1.4;color:#111;background:#fff;margin:12px;overflow-wrap:anywhere}img{display:none!important}a{pointer-events:none!important;color:inherit!important;text-decoration:underline}</style></head><body>${html}</body></html>`;
}
