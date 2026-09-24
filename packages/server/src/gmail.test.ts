import { describe, expect, it, vi } from 'vitest';

import { createGmailDraft, createGmailReplyDraft, readGmailThread, searchGmail } from './gmail.js';

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Gmail API', () => {
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
