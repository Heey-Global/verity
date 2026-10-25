import { describe, expect, it } from 'vitest';

import { formatAttachmentSize, gmailPreviewHtml, gmailSendSummary } from './gmailSendSummary.js';

describe('gmailSendSummary', () => {
  it('keeps every approved recipient and the complete body visible', () => {
    const body = `Hello,\n\n${'x'.repeat(10_000)}`;
    expect(
      gmailSendSummary({
        action: 'send_draft',
        draftId: 'd1',
        messageId: 'm1',
        to: ['to@example.test'],
        cc: ['cc@example.test'],
        bcc: ['bcc@example.test'],
        subject: 'repdoc Cloud – Anfrage',
        body,
        htmlBody: '<div>Hello</div><img src="https://images.example.test/logo.png">',
        externalUrls: ['https://images.example.test/logo.png'],
      }),
    ).toEqual({
      draftId: 'd1',
      to: ['to@example.test'],
      cc: ['cc@example.test'],
      bcc: ['bcc@example.test'],
      subject: 'repdoc Cloud – Anfrage',
      body,
      from: null,
      replyTo: null,
      htmlBody: '<div>Hello</div><img src="https://images.example.test/logo.png">',
      externalUrls: ['https://images.example.test/logo.png'],
      attachments: [],
    });
  });

  it('lists every attachment that will be sent', () => {
    const base = {
      action: 'send_draft',
      draftId: 'd1',
      to: ['to@example.test'],
      cc: [],
      bcc: [],
      subject: 'Report',
      body: 'See attached',
      externalUrls: [],
    };
    expect(
      gmailSendSummary({
        ...base,
        attachments: [
          {
            partId: '1',
            filename: 'report.pdf',
            mimeType: 'application/pdf',
            size: 2048,
            sha256: 'a'.repeat(64),
          },
        ],
      })?.attachments,
    ).toEqual([{ filename: 'report.pdf', mimeType: 'application/pdf', size: 2048 }]);
    // A card that dropped an unreadable entry would approve a file nobody saw.
    expect(gmailSendSummary({ ...base, attachments: [{ filename: 'x' }] })).toBeNull();
    expect(gmailSendSummary({ ...base, attachments: 'report.pdf' })).toBeNull();
  });

  it('formats attachment sizes for the approval card', () => {
    expect(formatAttachmentSize(512)).toBe('512 B');
    expect(formatAttachmentSize(2048)).toBe('2.0 KB');
    expect(formatAttachmentSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });

  it('renders the sanitized snapshot under an offline content policy', () => {
    const preview = gmailPreviewHtml('<a>Site</a><span>Logo</span>');
    expect(preview).toContain('Site');
    expect(preview).toContain("default-src 'none'");
    expect(preview).toContain('img{display:none!important}');
    expect(preview).toContain('a{pointer-events:none!important');
  });

  it('does not mistake another Gmail action for a send approval', () => {
    expect(gmailSendSummary({ action: 'create_draft', to: ['to@example.test'] })).toBeNull();
  });
});
