import { describe, expect, it } from 'vitest';

import { gmailPreviewHtml, gmailSendSummary } from './gmailSendSummary.js';

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
    });
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
