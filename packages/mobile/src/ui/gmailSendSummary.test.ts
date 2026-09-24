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

  it('renders HTML without loading images, links, scripts, or event handlers', () => {
    const preview = gmailPreviewHtml(
      '<script>bad()</script><a href="https://example.test" onclick="bad()">Site</a><img src="https://example.test/pixel">',
    );
    expect(preview).toContain('Site');
    expect(preview).toContain('[Image blocked in preview]');
    expect(preview).not.toContain('https://example.test');
    expect(preview).not.toContain('onclick');
    expect(preview).not.toContain('bad()');
    expect(preview).toContain("default-src 'none'");
  });

  it('does not mistake another Gmail action for a send approval', () => {
    expect(gmailSendSummary({ action: 'create_draft', to: ['to@example.test'] })).toBeNull();
  });
});
