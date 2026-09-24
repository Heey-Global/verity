import { describe, expect, it, vi } from 'vitest';

import {
  appendGmailSignature,
  createGmailDraft,
  createGmailReplyDraft,
  readGmailDraftForSend,
  readGmailSignature,
  readGmailThread,
  searchGmail,
  sendGmailDraft,
} from './gmail.js';

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Gmail API', () => {
  it('reads the configured send-as signature as safe plain text', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      response({
        signature:
          '<div>Best regards,<br><b>Jane &amp; Team</b><script>hidden()</script><img alt="Logo"></div>',
      }),
    );
    const signature = await readGmailSignature('token', 'me@example.test', fetch);
    expect(signature).toEqual({
      text: 'Best regards,\nJane & TeamLogo',
      html: '<div>Best regards,<br /><b>Jane &amp; Team</b><img alt="Logo" /></div>',
      externalUrls: [],
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs/me%40example.test',
    );
    expect(appendGmailSignature('Hello', signature)).toMatchObject({
      body: 'Hello\n\nBest regards,\nJane & TeamLogo',
      htmlBody: expect.stringContaining('<div>Hello</div>'),
    });
    const alreadySigned = appendGmailSignature(
      'Hello\n\nBest regards,\nJane & TeamLogo',
      signature,
    );
    expect(alreadySigned.body.match(/Best regards/gu)).toHaveLength(1);
    expect(alreadySigned.htmlBody.match(/Best regards/gu)).toHaveLength(1);
  });

  it('preserves block boundaries in the plain-text signature', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      response({
        signature: '<div>Jane Doe</div><div>Company</div>',
      }),
    );

    await expect(readGmailSignature('token', 'me@example.test', fetchImpl)).resolves.toMatchObject({
      text: 'Jane Doe\nCompany',
    });
  });

  it('searches with Gmail syntax and returns bounded metadata', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ messages: [{ id: 'm1', threadId: 't1' }] }))
      .mockResolvedValueOnce(
        response({
          id: 'm1',
          threadId: 't1',
          snippet: 'Hello',
          payload: { headers: [{ name: 'Subject', value: 'A subject' }] },
        }),
      );
    const result = await searchGmail('token', 'from:a@example.test', 5, undefined, fetch);
    expect(fetch.mock.calls[0]?.[0]).toContain('q=from%3Aa%40example.test&maxResults=5');
    expect(result).toMatchObject({
      messages: [{ id: 'm1', threadId: 't1', headers: { subject: 'A subject' } }],
    });
  });

  it('reads a thread and decodes base64url text bodies', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      response({
        id: 't1',
        messages: [
          {
            id: 'm1',
            payload: {
              mimeType: 'text/plain',
              body: { data: Buffer.from('Grüße').toString('base64url') },
            },
          },
        ],
      }),
    );
    await expect(readGmailThread('token', 't1', fetch)).resolves.toMatchObject({
      id: 't1',
      messages: [{ id: 'm1', text: 'Grüße' }],
    });
  });

  it('creates only a draft and builds an RFC 2822 reply', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response({ id: 'd1', message: { id: 'm1', threadId: 't1' } }));
    await expect(
      createGmailDraft(
        'token',
        {
          to: ['a@example.test'],
          subject: 'Re: Hello',
          body: 'Thanks!',
          threadId: 't1',
          inReplyTo: '<original@example.test>',
        },
        fetch,
      ),
    ).resolves.toEqual({ id: 'd1', messageId: 'm1', threadId: 't1' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts');
    const init = fetch.mock.calls[0]?.[1];
    expect(typeof init?.body).toBe('string');
    const request = JSON.parse(init?.body as string) as {
      message: { raw: string; threadId: string };
    };
    expect(init?.method).toBe('POST');
    expect(request.message.threadId).toBe('t1');
    expect(Buffer.from(request.message.raw, 'base64url').toString()).toContain(
      'In-Reply-To: <original@example.test>',
    );
  });

  it('rejects header injection before calling Gmail', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      createGmailDraft(
        'token',
        { to: ['a@example.test\r\nBcc: attacker@example.test'], subject: 'Hello', body: 'Body' },
        fetch,
      ),
    ).rejects.toThrow('to contains a line break');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('RFC 2047 encodes non-ASCII subjects instead of producing mojibake', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response({ id: 'd1', message: { id: 'm1' } }));
    await createGmailDraft(
      'token',
      {
        to: ['support@example.test'],
        subject: 'repdoc Cloud – Anfrage',
        body: 'Grüße',
      },
      fetch,
    );
    const body = fetch.mock.calls[0]?.[1]?.body;
    const request = JSON.parse(body as string) as { message: { raw: string } };
    const raw = Buffer.from(request.message.raw, 'base64url').toString('utf8');
    expect(raw).toContain(
      `Subject: =?UTF-8?B?${Buffer.from('repdoc Cloud – Anfrage').toString('base64')}?=`,
    );
    expect(raw).not.toContain('â€“');
  });

  it('encodes literal RFC 2047-looking ASCII so recipients see the approved text', async () => {
    const subject = 'Literal =?UTF-8?B?bm90IHRoaXM=?=';
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response({ id: 'd1', message: { id: 'm1' } }));
    await createGmailDraft('token', { to: ['support@example.test'], subject, body: 'Body' }, fetch);
    const request = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as {
      message: { raw: string };
    };
    const raw = Buffer.from(request.message.raw, 'base64url').toString('utf8');
    expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`);
    expect(raw).not.toContain(`Subject: ${subject}\r\n`);

    const encodedSubject = raw.match(/^Subject: ([^\r\n]+)$/mu)?.[1];
    const prepareFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      response({
        id: 'd1',
        message: {
          id: 'm1',
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'To', value: 'support@example.test' },
              { name: 'Subject', value: encodedSubject },
            ],
            body: { data: Buffer.from('Body').toString('base64url') },
          },
        },
      }),
    );
    const snapshot = await readGmailDraftForSend('token', 'd1', prepareFetch);
    expect(snapshot.subject).toBe(subject);
    const sendFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response({ id: 'sent-message' }));
    await sendGmailDraft('token', snapshot, sendFetch);
    const sendRequest = JSON.parse(sendFetch.mock.calls[0]?.[1]?.body as string) as { raw: string };
    expect(Buffer.from(sendRequest.raw, 'base64url').toString('utf8')).toContain(
      `Subject: ${encodedSubject ?? ''}`,
    );
  });

  it('keeps a Unicode subject readable through create, approval preview, and send', async () => {
    const subject = 'repdoc Cloud – Anfrage';
    const createFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response({ id: 'd1', message: { id: 'm1' } }));
    await createGmailDraft(
      'token',
      { to: ['support@example.test'], subject, body: 'Body' },
      createFetch,
    );
    const createBody = createFetch.mock.calls[0]?.[1]?.body;
    const created = JSON.parse(createBody as string) as { message: { raw: string } };
    const createdRaw = Buffer.from(created.message.raw, 'base64url').toString('utf8');
    const encodedSubject = createdRaw.match(/^Subject: ([^\r\n]+)$/mu)?.[1];
    expect(encodedSubject).toBeDefined();

    const prepareFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      response({
        id: 'd1',
        message: {
          id: 'm1',
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'To', value: 'support@example.test' },
              { name: 'Subject', value: encodedSubject },
            ],
            body: { data: Buffer.from('Body').toString('base64url') },
          },
        },
      }),
    );
    const snapshot = await readGmailDraftForSend('token', 'd1', prepareFetch);
    expect(snapshot.subject).toBe(subject);

    const sendFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response({ id: 'sent-message' }));
    await sendGmailDraft('token', snapshot, sendFetch);
    const sendBody = sendFetch.mock.calls[0]?.[1]?.body;
    const sent = JSON.parse(sendBody as string) as { raw: string };
    const sentRaw = Buffer.from(sent.raw, 'base64url').toString('utf8');
    expect(sentRaw).toContain(`Subject: ${encodedSubject ?? ''}`);
    expect(sentRaw).not.toContain('â€“');
  });

  it('sends only the exact plain-text draft snapshot that was approved', async () => {
    const snapshot = {
      draftId: 'd1',
      messageId: 'm1',
      to: ['friend@example.test'],
      cc: [],
      bcc: [],
      subject: 'Hello',
      body: 'Approved body',
      externalUrls: [],
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ id: 'sent-message', threadId: 't1' }));

    await expect(sendGmailDraft('token', snapshot, fetch)).resolves.toEqual({
      messageId: 'sent-message',
      threadId: 't1',
      draftRetained: true,
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    );
    const requestBody = fetch.mock.calls[0]?.[1]?.body;
    const request = JSON.parse(requestBody as string) as { raw: string };
    const raw = Buffer.from(request.raw, 'base64url').toString('utf8');
    expect(raw).toContain('To: friend@example.test');
    expect(raw).toContain('Subject: Hello');
    expect(raw).toContain('\r\n\r\nApproved body');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not truncate the body shown for send approval', async () => {
    const body = 'x'.repeat(100_001);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      response({
        id: 'd1',
        message: {
          id: 'm1',
          payload: {
            headers: [{ name: 'To', value: 'friend@example.test' }],
            mimeType: 'text/plain',
            body: { data: Buffer.from(body).toString('base64url') },
          },
        },
      }),
    );
    await expect(readGmailDraftForSend('token', 'd1', fetch)).resolves.toMatchObject({ body });
  });

  it('keeps commas inside quoted recipient addresses', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      response({
        id: 'd1',
        message: {
          id: 'm1',
          payload: {
            mimeType: 'text/plain',
            headers: [
              {
                name: 'To',
                value: '"Doe, Jane" <jane@example.test>, "local,part"@example.test',
              },
            ],
            body: { data: Buffer.from('Body').toString('base64url') },
          },
        },
      }),
    );
    await expect(readGmailDraftForSend('token', 'd1', fetch)).resolves.toMatchObject({
      to: ['"Doe, Jane" <jane@example.test>', '"local,part"@example.test'],
    });
  });

  it('rejects multipart content beyond the approved text and HTML alternatives', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      response({
        id: 'd1',
        message: {
          id: 'm1',
          payload: {
            mimeType: 'multipart/mixed',
            parts: [
              {
                mimeType: 'text/plain',
                body: { data: Buffer.from('Visible').toString('base64url') },
              },
              {
                mimeType: 'text/html',
                body: { data: Buffer.from('<p>Different</p>').toString('base64url') },
              },
            ],
          },
        },
      }),
    );
    await expect(readGmailDraftForSend('token', 'd1', fetch)).rejects.toThrow(
      'unsupported MIME content',
    );
  });

  it('prepares and sends a sanitized HTML alternative with disclosed external resources', async () => {
    const html =
      '<div>Hello<br><b>Jane</b><a href="https://example.test/profile">Profile</a><img src="https://example.test/logo.png" onerror="bad()"><img src="https:cdn.example.test/pixel.png"></div>';
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      response({
        id: 'd1',
        message: {
          id: 'm1',
          payload: {
            mimeType: 'multipart/alternative',
            headers: [
              { name: 'From', value: 'Sales <sales@example.test>' },
              { name: 'Reply-To', value: 'support@example.test' },
              { name: 'To', value: 'friend@example.test' },
              { name: 'Subject', value: 'Hello' },
            ],
            parts: [
              {
                mimeType: 'text/plain',
                headers: [{ name: 'Content-Type', value: 'text/plain; charset=UTF-8' }],
                body: { data: Buffer.from('Hello\n\nJane').toString('base64url') },
              },
              {
                mimeType: 'text/html',
                headers: [{ name: 'Content-Type', value: 'text/html; charset=UTF-8' }],
                body: { data: Buffer.from(html).toString('base64url') },
              },
            ],
          },
        },
      }),
    );
    const snapshot = await readGmailDraftForSend('token', 'd1', fetch);
    expect(snapshot).toMatchObject({
      body: 'Hello\n\nJane',
      from: 'Sales <sales@example.test>',
      replyTo: 'support@example.test',
      htmlBody:
        '<div>Hello<br /><b>Jane</b><a href="https://example.test/profile">Profile</a><img src="https://example.test/logo.png" /><img src="https:cdn.example.test/pixel.png" /></div>',
      externalUrls: [
        'https://example.test/profile',
        'https://example.test/logo.png',
        'https://cdn.example.test/pixel.png',
      ],
    });

    const sendFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response({ id: 'sent-message' }));
    await sendGmailDraft('token', snapshot, sendFetch);
    const request = JSON.parse(sendFetch.mock.calls[0]?.[1]?.body as string) as { raw: string };
    const raw = Buffer.from(request.raw, 'base64url').toString('utf8');
    expect(raw).toContain('Content-Type: multipart/alternative;');
    expect(raw).toContain('From: Sales <sales@example.test>');
    expect(raw).toContain('Reply-To: support@example.test');
    expect(raw).toContain('Content-Type: text/html; charset=UTF-8');
    expect(raw).not.toContain('onerror');
  });

  it('refuses HTML whose approval metadata does not match the outgoing snapshot', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      sendGmailDraft(
        'token',
        {
          draftId: 'd1',
          messageId: 'm1',
          to: ['friend@example.test'],
          cc: [],
          bcc: [],
          subject: 'Hello',
          body: 'Hello',
          htmlBody: '<div>Hello</div><script>hidden()</script>',
          externalUrls: [],
        },
        fetch,
      ),
    ).rejects.toThrow('HTML preview does not match');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a non-UTF-8 draft rather than corrupting its approval preview', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      response({
        id: 'd1',
        message: {
          id: 'm1',
          payload: {
            mimeType: 'text/plain',
            headers: [{ name: 'Content-Type', value: 'text/plain; charset=ISO-8859-1' }],
            body: { data: Buffer.from([0x47, 0x72, 0xfc, 0xdf, 0x65]).toString('base64url') },
          },
        },
      }),
    );
    await expect(readGmailDraftForSend('token', 'd1', fetch)).rejects.toThrow(
      'Unsupported Gmail draft character set: iso-8859-1',
    );
  });

  it('derives reply headers and recipient from the selected message', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response({
          messages: [
            {
              id: 'm1',
              payload: {
                headers: [
                  { name: 'From', value: 'Sender <sender@example.test>' },
                  { name: 'Reply-To', value: 'replies@example.test' },
                  { name: 'Subject', value: 'Hello' },
                  { name: 'Message-ID', value: '<m1@example.test>' },
                  { name: 'References', value: '<older@example.test>' },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({ id: 'd1', message: { id: 'draft-message', threadId: 't1' } }),
      );
    await createGmailReplyDraft('token', { threadId: 't1', messageId: 'm1', body: 'Reply' }, fetch);
    const body = fetch.mock.calls[1]?.[1]?.body;
    expect(typeof body).toBe('string');
    const request = JSON.parse(body as string) as {
      message: { raw: string; threadId: string };
    };
    const raw = Buffer.from(request.message.raw, 'base64url').toString();
    expect(request.message.threadId).toBe('t1');
    expect(raw).toContain('To: replies@example.test');
    expect(raw).toContain('Subject: Re: Hello');
    expect(raw).toContain('In-Reply-To: <m1@example.test>');
    expect(raw).toContain('References: <older@example.test> <m1@example.test>');
  });

  it('decodes an RFC 2047 subject before creating a reply subject', async () => {
    const encoded = `=?UTF-8?B?${Buffer.from('Grüße – Anfrage').toString('base64')}?=`;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response({
          messages: [
            {
              id: 'm1',
              payload: {
                headers: [
                  { name: 'From', value: 'sender@example.test' },
                  { name: 'Subject', value: encoded },
                  { name: 'Message-ID', value: '<m1@example.test>' },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(response({ id: 'd1', message: { id: 'draft-message' } }));

    await createGmailReplyDraft('token', { threadId: 't1', body: 'Reply' }, fetch);

    const request = JSON.parse(fetch.mock.calls[1]?.[1]?.body as string) as {
      message: { raw: string };
    };
    const raw = Buffer.from(request.message.raw, 'base64url').toString('utf8');
    expect(raw).toContain(
      `Subject: =?UTF-8?B?${Buffer.from('Re: Grüße – Anfrage').toString('base64')}?=`,
    );
    expect(raw).not.toContain(Buffer.from(encoded).toString('base64'));
  });

  it('decodes a legacy RFC 2047 charset before creating a reply subject', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response({
          messages: [
            {
              id: 'm1',
              payload: {
                headers: [
                  { name: 'From', value: 'sender@example.test' },
                  { name: 'Subject', value: '=?ISO-8859-1?Q?Gr=FC=DFe?=' },
                  { name: 'Message-ID', value: '<m1@example.test>' },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(response({ id: 'd1', message: { id: 'draft-message' } }));

    await createGmailReplyDraft('token', { threadId: 't1', body: 'Reply' }, fetch);

    const request = JSON.parse(fetch.mock.calls[1]?.[1]?.body as string) as {
      message: { raw: string };
    };
    const raw = Buffer.from(request.message.raw, 'base64url').toString('utf8');
    expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from('Re: Grüße').toString('base64')}?=`);
  });

  it('replies to the latest incoming message when the thread ends with a sent message', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response({
          messages: [
            {
              id: 'incoming',
              payload: {
                headers: [
                  { name: 'From', value: 'friend@example.test' },
                  { name: 'Subject', value: 'Hello' },
                  { name: 'Message-ID', value: '<incoming@example.test>' },
                ],
              },
            },
            {
              id: 'sent',
              labelIds: ['SENT'],
              payload: {
                headers: [
                  { name: 'From', value: 'me@example.test' },
                  { name: 'To', value: 'friend@example.test' },
                  { name: 'Subject', value: 'Re: Hello' },
                  { name: 'Message-ID', value: '<sent@example.test>' },
                ],
              },
            },
            {
              id: 'draft',
              labelIds: ['DRAFT'],
              payload: {
                headers: [
                  { name: 'From', value: 'me@example.test' },
                  { name: 'To', value: 'friend@example.test' },
                  { name: 'Subject', value: 'Re: Hello' },
                  { name: 'Message-ID', value: '<draft@example.test>' },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({ id: 'd1', message: { id: 'draft-message', threadId: 't1' } }),
      );

    await createGmailReplyDraft('token', { threadId: 't1', body: 'Another reply' }, fetch);

    const body = fetch.mock.calls[1]?.[1]?.body;
    expect(typeof body).toBe('string');
    const request = JSON.parse(body as string) as { message: { raw: string } };
    const raw = Buffer.from(request.message.raw, 'base64url').toString();
    expect(raw).toContain('To: friend@example.test');
    expect(raw).toContain('In-Reply-To: <incoming@example.test>');
  });

  it('uses the sent recipient when a sent-only thread ends with a draft', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response({
          messages: [
            {
              id: 'sent',
              labelIds: ['SENT'],
              payload: {
                headers: [
                  { name: 'From', value: 'me@example.test' },
                  { name: 'To', value: 'friend@example.test' },
                  { name: 'Subject', value: 'Hello' },
                  { name: 'Message-ID', value: '<sent@example.test>' },
                ],
              },
            },
            {
              id: 'draft',
              labelIds: ['DRAFT'],
              payload: {
                headers: [
                  { name: 'From', value: 'me@example.test' },
                  { name: 'To', value: 'friend@example.test' },
                  { name: 'Message-ID', value: '<draft@example.test>' },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({ id: 'd1', message: { id: 'draft-message', threadId: 't1' } }),
      );

    await createGmailReplyDraft('token', { threadId: 't1', body: 'Follow-up' }, fetch);

    const body = fetch.mock.calls[1]?.[1]?.body;
    expect(typeof body).toBe('string');
    const request = JSON.parse(body as string) as { message: { raw: string } };
    const raw = Buffer.from(request.message.raw, 'base64url').toString();
    expect(raw).toContain('To: friend@example.test');
    expect(raw).toContain('In-Reply-To: <sent@example.test>');
    expect(raw).not.toContain('<draft@example.test>');
  });
});
