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
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
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
  if (
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
  };
}

export function gmailPreviewHtml(html: string): string {
  // The gateway supplies the server's allowlist-sanitized snapshot. The WebView disables
  // JavaScript and navigation, while this policy prevents every remote resource from loading.
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{font-family:-apple-system,system-ui,sans-serif;font-size:15px;line-height:1.4;color:#111;background:#fff;margin:12px;overflow-wrap:anywhere}img{display:none!important}a{pointer-events:none!important;color:inherit!important;text-decoration:underline}</style></head><body>${html}</body></html>`;
}
