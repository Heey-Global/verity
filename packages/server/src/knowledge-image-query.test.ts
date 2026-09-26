import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeImageQuery } from './knowledge-image-query.js';

const image = { kind: 'image' as const, mediaType: 'image/png' as const, data: 'aW1hZ2U=' };
const input = { cwd: '/private/project', prompt: 'Transcribe', attachments: [image] };
const sse = (...events: object[]) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
const completed = { type: 'response.completed', response: { status: 'completed' } };
function setup(response: Response) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
  const fallback = vi.fn(async () => 'Claude result');
  const codexCredential = vi.fn(async () => ({
    accessToken: 'test-access',
    accountId: 'test-account',
  }));
  const openCode = vi.fn(async () => ({
    baseUrl: 'https://provider.example/v1/',
    apiKey: 'test-key',
  }));
  return {
    fetch,
    fallback,
    codexCredential,
    openCode,
    query: createKnowledgeImageQuery({
      fetch,
      fallback,
      codexCredential,
      openCode,
      codexDefaultModel: async () => 'codex/catalog-first',
    }),
  };
}

describe('direct Knowledge image query', () => {
  it('sends images to Codex with the gateway credential and no tools or project context', async () => {
    const ctx = setup(
      new Response(
        sse(
          { type: 'response.output_text.delta', delta: 'Do not duplicate this' },
          { type: 'response.output_text.done', text: 'Invoice 7319' },
          completed,
        ),
      ),
    );
    expect(await ctx.query({ ...input, model: 'codex/test-model' })).toBe('Invoice 7319');
    const [url, options] = ctx.fetch.mock.calls[0]!;
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(options).toMatchObject({
      redirect: 'error',
      headers: {
        authorization: 'Bearer test-access',
        'chatgpt-account-id': 'test-account',
      },
    });
    // A correct transcription alone would not catch accidentally enabling tools.
    expect(JSON.parse(options!.body as string)).toEqual({
      model: 'test-model',
      instructions: input.prompt,
      input: [
        {
          role: 'user',
          content: [{ type: 'input_image', image_url: `data:image/png;base64,${image.data}` }],
        },
      ],
      tools: [],
      tool_choice: 'none',
      store: false,
      stream: true,
    });
    expect(ctx.fallback).not.toHaveBeenCalled();
    expect(ctx.openCode).not.toHaveBeenCalled();
  });

  it('resolves the legacy Codex default alias from the catalog', async () => {
    const ctx = setup(new Response(sse(completed)));
    await ctx.query({ ...input, model: 'codex/default' });
    expect(JSON.parse(ctx.fetch.mock.calls[0]![1]!.body as string).model).toBe('catalog-first');
  });

  it('preserves nested provider model names for OpenCode and disables tools', async () => {
    const ctx = setup(
      Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: 'Text', tool_calls: null, function_call: null },
          },
        ],
      }),
    );
    expect(await ctx.query({ ...input, model: 'verity/provider/vision' })).toBe('Text');
    const [url, options] = ctx.fetch.mock.calls[0]!;
    expect(url).toBe('https://provider.example/v1/chat/completions');
    expect(options).toMatchObject({
      redirect: 'error',
      headers: { authorization: 'Bearer test-key' },
    });
    expect(JSON.parse(options!.body as string)).toEqual({
      model: 'provider/vision',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: input.prompt },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${image.data}` } },
          ],
        },
      ],
      tools: [],
      tool_choice: 'none',
      max_tokens: 8192,
      stream: false,
    });
    expect(ctx.codexCredential).not.toHaveBeenCalled();
    expect(ctx.fallback).not.toHaveBeenCalled();
  });

  it('keeps Claude on the existing isolated agent path', async () => {
    const ctx = setup(new Response());
    expect(await ctx.query({ ...input, model: 'claude-test' })).toBe('Claude result');
    expect(ctx.fallback).toHaveBeenCalledWith({ ...input, model: 'claude-test' });
    expect(ctx.fetch).not.toHaveBeenCalled();
  });

  it.each(['response.failed', 'response.incomplete', 'error', 'disconnected'])(
    'rejects partial Codex text on %s',
    async (type) => {
      const ctx = setup(
        new Response(sse({ type: 'response.output_text.done', text: 'Partial text' }, { type })),
      );
      await expect(ctx.query({ ...input, model: 'codex/test' })).rejects.toThrow();
    },
  );

  it.each(['length', 'tool_calls', 'content_filter'])(
    'rejects OpenCode completion ending with %s',
    async (finish_reason) => {
      const ctx = setup(
        Response.json({ choices: [{ finish_reason, message: { content: 'Partial' } }] }),
      );
      await expect(ctx.query({ ...input, model: 'verity/test' })).rejects.toThrow();
    },
  );

  it('rejects unsolicited tool calls even with a stop reason', async () => {
    const ctx = setup(
      Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: 'Text',
              tool_calls: [{ name: 'read' }],
            },
          },
        ],
      }),
    );
    await expect(ctx.query({ ...input, model: 'verity/test' })).rejects.toThrow();
  });

  it('does not expose upstream error bodies or fall back to an agent', async () => {
    const ctx = setup(new Response('private upstream details', { status: 401 }));
    await expect(ctx.query({ ...input, model: 'codex/test' })).rejects.toThrow('HTTP 401');
    expect(ctx.fallback).not.toHaveBeenCalled();
  });

  it('bounds streamed responses without relying on Content-Length', async () => {
    const ctx = setup(new Response('x'.repeat(1_000_001)));
    await expect(ctx.query({ ...input, model: 'codex/test' })).rejects.toThrow('size limit');
  });

  it('propagates cancellation to the direct request', async () => {
    const ctx = setup(new Response(sse(completed)));
    const controller = new AbortController();
    await ctx.query({ ...input, model: 'codex/test', signal: controller.signal });
    controller.abort();
    expect(ctx.fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });

  it('fails closed when the configured OpenCode URL is insecure', async () => {
    const ctx = setup(new Response());
    ctx.openCode.mockResolvedValue({ baseUrl: 'http://provider.example', apiKey: 'test-key' });
    await expect(ctx.query({ ...input, model: 'verity/test' })).rejects.toThrow('URL is invalid');
    expect(ctx.fetch).not.toHaveBeenCalled();
  });
  it('rejects malformed response JSON without exposing its content', async () => {
    const ctx = setup(new Response('private-content-not-json'));
    await expect(ctx.query({ ...input, model: 'verity/test' })).rejects.toThrow(
      'Invalid image model JSON response',
    );
  });

  it('rejects unsolicited Codex tool output', async () => {
    const ctx = setup(
      new Response(
        sse(
          { type: 'response.output_item.added', item: { type: 'function_call' } },
          { type: 'response.output_text.done', text: 'Text' },
          completed,
        ),
      ),
    );
    await expect(ctx.query({ ...input, model: 'codex/test' })).rejects.toThrow('requested a tool');
  });

  it('does not send an image when Codex is signed out', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const query = createKnowledgeImageQuery({
      fallback: async () => undefined,
      codexDefaultModel: async () => undefined,
      openCode: async () => undefined,
      fetch,
    });
    await expect(query({ ...input, model: 'codex/test' })).rejects.toThrow('login unavailable');
    expect(fetch).not.toHaveBeenCalled();
  });
});
